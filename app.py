"""GamePicker — локальный подборщик игр Steam по твоей библиотеке.

Запуск:  python app.py      → откроется http://127.0.0.1:8765
Никаких сторонних библиотек не нужно (только Python 3.9+).
"""
import json
import re
import urllib.error
import urllib.request
import os
import sys
import socket
import threading
import time
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from recommender import build_profile, library_summary, recommend
from steam_api import BASE_DIR, DATA_DIR, FROZEN, SteamError, owned_games, resolve_steamid
from summarizer import summarize
import userdata

LOG_PATH = os.path.join(DATA_DIR, "gamepicker.log")
# В exe (и вообще без консоли) весь вывод пишем в лог-файл
if FROZEN or sys.stdout is None or sys.stderr is None:
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 1_000_000:
            os.replace(LOG_PATH, LOG_PATH + ".old")
        _log = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
        sys.stdout = _log if (FROZEN or sys.stdout is None) else sys.stdout
        sys.stderr = _log if (FROZEN or sys.stderr is None) else sys.stderr
    except OSError:
        pass


def log(msg):
    try:
        print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)
    except Exception:  # noqa: BLE001
        pass


def fatal_box(text):
    """Показать ошибку окном Windows (в exe нет консоли)."""
    log("FATAL: " + text)
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                None, f"{text}\n\nЛог: {LOG_PATH}", "GamePicker — ошибка", 0x10)
        except Exception:  # noqa: BLE001
            pass

HOST, PORT = "127.0.0.1", int(os.environ.get("GAMEPICKER_PORT", "8765"))
STATIC = os.path.join(BASE_DIR, "static")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
APP_VERSION = "1.3.1"
LAST_PING = [0.0]
WEBVIEW = {"active": False, "module": None, "extra": []}
POPUP_HOSTS = re.compile(r"^(www\.)?tiktok\.com$")
DEFAULT_CONFIG = {
    "steam_api_key": "",
    "steam_profile": "",
    "country": "ua",
    "anthropic_api_key": "",
    "claude_model": "claude-haiku-5-5",
    "anthropic_workspace": "",
}

STATE = {"games": None, "profile": None, "steamid": None, "summary": None}
JOBS = {}
LOCK = threading.Lock()


# ---------------------------------------------------------------- конфиг

def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update(json.load(f))
    except (OSError, ValueError):
        pass
    # переменные окружения имеют приоритет
    cfg["steam_api_key"] = os.environ.get("STEAM_API_KEY", cfg["steam_api_key"])
    cfg["anthropic_api_key"] = os.environ.get("ANTHROPIC_API_KEY", cfg["anthropic_api_key"])
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def public_config(cfg):
    def mask(k):
        return (k[:4] + "…" + k[-4:]) if len(k) > 10 else ("•••" if k else "")
    return {
        "configured": bool(cfg["steam_api_key"] and cfg["steam_profile"]),
        "steam_profile": cfg["steam_profile"],
        "country": cfg["country"],
        "steam_key_mask": mask(cfg["steam_api_key"]),
        "anthropic_key_mask": mask(cfg["anthropic_api_key"]),
        "has_ai": bool(cfg["anthropic_api_key"]),
        "claude_model": cfg["claude_model"],
        "anthropic_workspace": cfg.get("anthropic_workspace", ""),
    }


# ---------------------------------------------------------------- фоновые задачи

def start_job(fn):
    job_id = uuid.uuid4().hex[:12]
    job = {"status": "running", "progress": 0.0, "stage": "start", "detail": "", "result": None, "error": None}
    JOBS[job_id] = job

    def progress(p, stage, detail=""):
        job.update(progress=round(min(1.0, max(0.0, p)), 3), stage=stage, detail=detail)

    def run():
        try:
            job["result"] = fn(progress)
            job["status"] = "done"
            job["progress"] = 1.0
        except SteamError as e:
            job.update(status="error", error={"code": e.code, "detail": e.detail})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job.update(status="error", error={"code": "internal", "detail": str(e)})

    threading.Thread(target=run, daemon=True).start()
    # старые задачи чистим
    if len(JOBS) > 50:
        for k in list(JOBS)[:-50]:
            JOBS.pop(k, None)
    return job_id


def job_library(progress):
    cfg = load_config()
    if not cfg["steam_api_key"] or not cfg["steam_profile"]:
        raise SteamError("not_configured")
    progress(0.02, "library")
    steamid = resolve_steamid(cfg["steam_api_key"], cfg["steam_profile"])
    games = owned_games(cfg["steam_api_key"], steamid)
    profile = build_profile(games, lambda p, s, d="": progress(0.05 + 0.95 * p, s, d))
    if not profile["tags"]:
        raise SteamError("empty_profile")
    summary = library_summary(games, profile)
    with LOCK:
        STATE.update(games=games, profile=profile, steamid=steamid, summary=summary)
    return summary


def job_recommend(filters):
    def run(progress):
        if not STATE["games"]:
            job_library(lambda p, s, d="": progress(0.3 * p, s, d))
            inner = lambda p, s, d="": progress(0.3 + 0.7 * p, s, d)  # noqa: E731
        else:
            inner = progress
        cfg = load_config()
        filters.setdefault("cc", cfg["country"] or "ua")
        filters["skip"] = list(filters.get("skip") or []) + list(userdata.excluded_ids())
        return recommend(STATE, filters, inner)
    return run


# ---------------------------------------------------------------- HTTP

MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}


MEDIA_HOST = re.compile(r"^[a-z0-9.-]+\.(steamstatic\.com|steampowered\.com|akamaihd\.net|steamcontent\.com)$")
MEDIA_ABS = re.compile(r"https?://([a-z0-9.-]+\.(?:steamstatic\.com|steampowered\.com|akamaihd\.net|steamcontent\.com))/")
MEDIA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


class Handler(BaseHTTPRequestHandler):
    server_version = "GamePicker/1.0"

    def log_message(self, fmt, *args):  # тише в консоли
        first = str(args[0]) if args else ""
        if "/api/job" not in first and "/api/ping" not in first and "/media/" not in first:
            sys.stderr.write("%s\n" % (fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except ValueError:
            return {}

    def _static(self, rel):
        rel = rel.lstrip("/") or "index.html"
        path = os.path.normpath(os.path.join(STATIC, rel))
        if not path.startswith(STATIC) or not os.path.isfile(path):
            return self._send(404, {"error": "not_found"})
        with open(path, "rb") as f:
            self._send(200, f.read(), MIME.get(os.path.splitext(path)[1], "application/octet-stream"))

    def _media(self, rest, query):
        """Прокси для трейлеров Steam (HLS): свой адрес — браузер не упирается в CORS."""
        host, _, path = rest.partition("/")
        if not MEDIA_HOST.match(host) or not path:
            return self._send(404, {"error": "bad_media_host"})
        target = f"https://{host}/{path}" + (f"?{query}" if query else "")
        hdrs = {"User-Agent": MEDIA_UA, "Referer": "https://store.steampowered.com/"}
        if self.headers.get("Range"):
            hdrs["Range"] = self.headers["Range"]
        try:
            with urllib.request.urlopen(urllib.request.Request(target, headers=hdrs), timeout=30) as r:
                ctype = r.headers.get("Content-Type", "application/octet-stream")
                if path.endswith(".m3u8") or "mpegurl" in ctype.lower():
                    text = r.read().decode("utf-8", "replace")
                    text = MEDIA_ABS.sub(lambda m: f"/media/{m.group(1)}/", text)
                    return self._send(200, text.encode("utf-8"), "application/vnd.apple.mpegurl")
                self.send_response(r.status)
                for h in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
                    if r.headers.get(h):
                        self.send_header(h, r.headers[h])
                self.send_header("Cache-Control", "max-age=86400")
                self.end_headers()
                while True:
                    chunk = r.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except urllib.error.HTTPError as e:
            self._send(e.code, {"error": "upstream", "code": e.code})
        except (ConnectionError, BrokenPipeError, TimeoutError, urllib.error.URLError, OSError):
            pass  # зритель перемотал или закрыл видео

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/api/ping":
            LAST_PING[0] = time.monotonic()
            return self._send(200, {"ok": True, "version": APP_VERSION})
        if url.path == "/api/config":
            return self._send(200, public_config(load_config()))
        if url.path == "/api/library":
            return self._send(200, {"summary": STATE["summary"]})
        if url.path == "/api/hidden":
            return self._send(200, {"items": userdata.hidden_list()})
        if url.path == "/api/family":
            return self._send(200, userdata.family_status())
        if url.path == "/api/job":
            job = JOBS.get(q.get("id", ""))
            return self._send(200 if job else 404, job or {"error": "no_job"})
        if url.path == "/api/summary":
            cfg = load_config()
            try:
                appid = int(q.get("appid", "0"))
                res = summarize(appid, q.get("name", ""), q.get("lang", "ru"),
                                cfg["anthropic_api_key"], cfg["claude_model"],
                                cfg.get("anthropic_workspace", ""))
                return self._send(200, res)
            except SteamError as e:
                return self._send(502, {"error": {"code": e.code, "detail": e.detail}})
            except ValueError:
                return self._send(400, {"error": {"code": "bad_request"}})
        if url.path.startswith("/media/"):
            return self._media(url.path[len("/media/"):], url.query)
        if url.path.startswith("/api/"):
            return self._send(404, {"error": "not_found"})
        return self._static("index.html" if url.path == "/" else url.path)

    def do_POST(self):
        url = urlparse(self.path)
        body = self._body()
        if url.path == "/api/config":
            cfg = load_config()
            for k in ("steam_profile", "country", "claude_model", "anthropic_workspace"):
                if k in body and isinstance(body[k], str):
                    cfg[k] = body[k].strip()
            for k in ("steam_api_key", "anthropic_api_key"):
                v = body.get(k)
                if isinstance(v, str) and v.strip() and "…" not in v and v != "•••":
                    cfg[k] = v.strip()
                if body.get("clear_" + k):
                    cfg[k] = ""
            save_config(cfg)
            with LOCK:
                STATE.update(games=None, profile=None, steamid=None, summary=None)
            return self._send(200, public_config(cfg))
        if url.path == "/api/library":
            return self._send(200, {"job": start_job(job_library)})
        if url.path == "/api/hidden":
            try:
                userdata.hide(body["appid"], body.get("name", ""), body.get("image", ""), body.get("reason", ""))
            except (KeyError, ValueError, TypeError):
                return self._send(400, {"error": {"code": "bad_request"}})
            return self._send(200, {"items": userdata.hidden_list()})
        if url.path == "/api/hidden/remove":
            if body.get("all"):
                userdata.unhide(reason=body.get("reason"))
            elif body.get("appid") is not None:
                userdata.unhide(appid=body["appid"])
            return self._send(200, {"items": userdata.hidden_list()})
        if url.path == "/api/hidden/import":  # перенос старого списка из браузера
            for aid in body.get("appids", []):
                if str(aid).isdigit():
                    userdata.hide(aid)
            return self._send(200, {"items": userdata.hidden_list()})
        if url.path == "/api/window":  # TikTok в отдельном окне приложения
            target = str(body.get("url", ""))
            host = urlparse(target).hostname or ""
            if not target.startswith("https://") or not POPUP_HOSTS.match(host):
                return self._send(400, {"error": {"code": "bad_request"}})
            if not WEBVIEW["active"]:
                return self._send(200, {"opened": False})
            try:
                wv = WEBVIEW["module"]
                title = str(body.get("title") or "TikTok")[:80]
                w = wv.create_window(title, target, width=460, height=860, min_size=(360, 560),
                                     background_color="#000000")
                WEBVIEW["extra"].append(w)
                return self._send(200, {"opened": True})
            except Exception:  # noqa: BLE001
                log("Не открылось окно TikTok:\n" + traceback.format_exc())
                return self._send(200, {"opened": False})
        if url.path == "/api/family":
            if body.get("clear"):
                userdata.family_clear()
                return self._send(200, userdata.family_status())
            cfg = load_config()
            try:
                steamid = STATE["steamid"] or resolve_steamid(cfg["steam_api_key"], cfg["steam_profile"])
                return self._send(200, userdata.family_import(body.get("token", ""), steamid))
            except SteamError as e:
                return self._send(400, {"error": {"code": e.code, "detail": e.detail}})
        if url.path == "/api/recommend":
            return self._send(200, {"job": start_job(job_recommend(body))})
        return self._send(404, {"error": "not_found"})


def free_port(preferred):
    for port in [preferred] + list(range(preferred + 1, preferred + 20)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((HOST, port))
                return port
            except OSError:
                continue
    return 0


def watchdog(srv):
    """Без окна приложения (режим браузера в exe): выключаемся, когда вкладку закрыли."""
    while True:
        time.sleep(10)
        if LAST_PING[0] and time.monotonic() - LAST_PING[0] > 45:
            log("Вкладка закрыта — выход")
            srv.shutdown()
            srv._stopped = True
            return


def already_running(port):
    """Если GamePicker уже запущен — вернуть его адрес."""
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/api/ping", timeout=1.5) as r:
            if json.loads(r.read().decode()).get("ok"):
                return f"http://{HOST}:{port}"
    except Exception:  # noqa: BLE001
        pass
    return None


def run_window(url):
    """Открыть приложение в собственном окне. True — окно было показано."""
    try:
        import webview  # pywebview
    except Exception:  # noqa: BLE001
        log("pywebview недоступен:\n" + traceback.format_exc())
        return False
    shown = threading.Event()
    try:
        win = webview.create_window("GamePicker", url, width=1360, height=900, min_size=(420, 600),
                                    background_color="#e9e6f2", text_select=True)
        win.events.shown += shown.set
        WEBVIEW["module"] = webview
        win.events.shown += lambda: WEBVIEW.update(active=True)
        kwargs = {"gui": "edgechromium"} if os.name == "nt" else {}
        kwargs.update(private_mode=False, storage_path=os.path.join(DATA_DIR, "webview"))
        webview.start(**kwargs)
    except Exception:  # noqa: BLE001 — нет WebView2 и т.п.
        log("Окно не открылось:\n" + traceback.format_exc())
        return shown.is_set()
    if not shown.is_set():
        log("webview.start завершился, а окно так и не показалось")
    return shown.is_set()


def main():
    log(f"Старт GamePicker {APP_VERSION}, frozen={FROZEN}, argv={sys.argv[1:]}")
    mode_browser = "--browser" in sys.argv
    headless = "--no-browser" in sys.argv

    running = already_running(PORT)
    if running and not headless:
        log("Уже запущен — открываю его")
        if not (not mode_browser and run_window(running)):
            webbrowser.open(running)
        return

    port = free_port(PORT)
    srv = ThreadingHTTPServer((HOST, port), Handler)
    url = f"http://{HOST}:{srv.server_address[1]}"
    log(f"Сервер: {url}")
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    if not headless and not mode_browser:
        if run_window(url):
            for w in WEBVIEW["extra"]:
                try:
                    w.destroy()
                except Exception:  # noqa: BLE001
                    pass
            log("Окно закрыто — выход")
            srv.shutdown()
            return
        log("Открываю в браузере")

    if not headless:
        webbrowser.open(url)
    if FROZEN:
        threading.Thread(target=watchdog, args=(srv,), daemon=True).start()
    try:
        while True:
            time.sleep(1)
            if getattr(srv, "_stopped", False):
                break
    except KeyboardInterrupt:
        print("\nОстановлено.")
        srv.shutdown()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        fatal_box("GamePicker не смог запуститься:\n\n" + traceback.format_exc(limit=3))
        sys.exit(1)
