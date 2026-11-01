"""Обновление GamePicker.exe прямо из приложения через релизы GitHub.

Схема: проверяем последний релиз → скачиваем новый exe в %APPDATA%\\GamePicker\\update →
переименовываем работающий exe в *.old (Windows это разрешает) → кладём новый на его место →
запускаем его и выходим. Старый *.old удаляется при следующем запуске.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from steam_api import DATA_DIR, FROZEN

REPO = os.environ.get("GAMEPICKER_REPO", "fvackingsonic/GamePicker")
UA = "GamePicker-updater"
UPDATE_DIR = os.path.join(DATA_DIR, "update")
STATE = {"status": "idle", "progress": 0.0, "error": None, "file": None, "version": None}
_CACHE = {"ts": 0.0, "data": None}
_lock = threading.Lock()


def _ver(v):
    nums = [int(x) for x in re.findall(r"\d+", str(v))[:3]]
    return tuple(nums + [0] * (3 - len(nums)))


def can_install():
    return FROZEN and os.name == "nt"


def check(current, force=False):
    """Информация о последнем релизе. Кэш на 3 часа, чтобы не упираться в лимит GitHub."""
    if not force and _CACHE["data"] and time.time() - _CACHE["ts"] < 3 * 3600:
        return _CACHE["data"]
    hdrs = {"Accept": "application/vnd.github+json", "User-Agent": UA}
    if os.environ.get("GAMEPICKER_GH_TOKEN"):  # только в сборке на GitHub, чтобы не упереться в лимит
        hdrs["Authorization"] = "Bearer " + os.environ["GAMEPICKER_GH_TOKEN"]
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/releases/latest", headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            rel = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # 404 у приватного репозитория без входа
        data = {"available": False, "current": current, "error": "not_public" if e.code == 404 else f"http_{e.code}"}
        _CACHE.update(ts=time.time(), data=data)
        return data
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return {"available": False, "current": current, "error": "network"}

    tag = rel.get("tag_name", "")
    asset = next((a for a in rel.get("assets", []) if a.get("name", "").lower().endswith(".exe")), None)
    data = {
        "available": bool(asset) and _ver(tag) > _ver(current),
        "current": current,
        "version": tag.lstrip("v"),
        "notes": rel.get("body", ""),
        "page": rel.get("html_url"),
        "published": rel.get("published_at"),
        "can_install": can_install(),
        "error": None,
        "_asset": {
            "url": asset.get("browser_download_url"),
            "api_url": asset.get("url"),
            "size": asset.get("size"),
            "digest": asset.get("digest") or "",
        } if asset else None,
    }
    _CACHE.update(ts=time.time(), data=data)
    return data


def public(data):
    return {k: v for k, v in data.items() if not k.startswith("_")}


def start_download(current):
    with _lock:
        if STATE["status"] in ("downloading", "ready"):
            return dict(STATE)
        info = check(current)
        if not info.get("available") or not info.get("_asset"):
            raise RuntimeError("no_update")
        if not can_install():
            raise RuntimeError("not_exe")
        STATE.update(status="downloading", progress=0.0, error=None, file=None, version=info["version"])
    threading.Thread(target=_download, args=(info,), daemon=True).start()
    return dict(STATE)


def _download(info):
    asset = info["_asset"]
    os.makedirs(UPDATE_DIR, exist_ok=True)
    path = os.path.join(UPDATE_DIR, f"GamePicker-{info['version']}.exe")
    tmp = path + ".part"
    try:
        token = os.environ.get("GAMEPICKER_GH_TOKEN")
        if token and asset.get("api_url"):  # проверка в сборке: приватный репозиторий
            req = urllib.request.Request(asset["api_url"], headers={
                "User-Agent": UA, "Accept": "application/octet-stream", "Authorization": "Bearer " + token})
        else:
            req = urllib.request.Request(asset["url"], headers={"User-Agent": UA, "Accept": "application/octet-stream"})
        sha = hashlib.sha256()
        got = 0
        total = asset.get("size") or 0
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            total = total or int(r.headers.get("Content-Length") or 0)
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                sha.update(chunk)
                got += len(chunk)
                if total:
                    STATE["progress"] = round(min(0.99, got / total), 3)
        if total and got != total:
            raise RuntimeError(f"size {got} != {total}")
        with open(tmp, "rb") as f:
            if f.read(2) != b"MZ":
                raise RuntimeError("not an exe")
        digest = asset.get("digest", "")
        if digest.startswith("sha256:") and digest[7:].lower() != sha.hexdigest():
            raise RuntimeError("checksum mismatch")
        os.replace(tmp, path)
        STATE.update(status="ready", progress=1.0, file=path)
    except Exception as e:  # noqa: BLE001
        try:
            os.remove(tmp)
        except OSError:
            pass
        STATE.update(status="error", error=str(e))


def apply_and_restart(before_exit):
    """Заменить exe и перезапуститься. before_exit — закрыть сервер, чтобы порт освободился."""
    if STATE["status"] != "ready" or not STATE["file"]:
        raise RuntimeError("not_ready")
    exe = sys.executable
    old = exe + ".old"
    try:
        if os.path.exists(old):
            os.remove(old)
    except OSError:
        old = exe + f".{int(time.time())}.old"
    os.replace(exe, old)              # работающий exe можно переименовать
    try:
        os.replace(STATE["file"], exe)
    except OSError:
        os.replace(old, exe)          # откат
        raise

    def go():
        time.sleep(0.4)
        try:
            before_exit()
        finally:
            flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
            subprocess.Popen([exe, "--after-update"], close_fds=True, creationflags=flags)
            os._exit(0)
    threading.Thread(target=go, daemon=True).start()


def cleanup_old():
    """Удалить старый exe после обновления."""
    if not FROZEN:
        return
    folder = os.path.dirname(sys.executable)
    base = os.path.basename(sys.executable)
    for name in os.listdir(folder):
        if name.startswith(base + ".") and name.endswith(".old"):
            try:
                os.remove(os.path.join(folder, name))
            except OSError:
                pass
