"""Данные пользователя на диске: скрытые игры и импортированная семейная библиотека."""
import json
import os
import re
import threading
import time

from steam_api import DATA_DIR, SteamError, http_json

PATH = os.path.join(DATA_DIR, "userdata.json")
_lock = threading.Lock()
REASONS = ("not_interested", "owned")


def _empty():
    return {"hidden": {}, "family": {"apps": {}, "updated": 0}}


def _load():
    try:
        with open(PATH, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return _empty()
    base = _empty()
    base.update(d)
    return base


def _save(d):
    tmp = PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, PATH)


def get():
    with _lock:
        return _load()


def update(fn):
    with _lock:
        d = _load()
        fn(d)
        _save(d)
        return d


# ---------------------------------------------------------------- скрытые

def hidden_list():
    items = list(get()["hidden"].values())
    items.sort(key=lambda x: -x.get("ts", 0))
    return items


def hide(appid, name="", image="", reason="not_interested"):
    appid = int(appid)
    reason = reason if reason in REASONS else "not_interested"

    def fn(d):
        old = d["hidden"].get(str(appid), {})
        d["hidden"][str(appid)] = {
            "appid": appid,
            "name": name or old.get("name") or "",
            "image": image or old.get("image") or "",
            "reason": reason,
            "ts": int(time.time()),
        }
    update(fn)


def unhide(appid=None, reason=None):
    def fn(d):
        if appid is not None:
            d["hidden"].pop(str(int(appid)), None)
        else:
            d["hidden"] = {k: v for k, v in d["hidden"].items() if reason and v.get("reason") != reason}
    update(fn)


# ---------------------------------------------------------------- семейная библиотека

def _extract_token(raw):
    raw = (raw or "").strip()
    m = re.search(r'"webapi_token"\s*:\s*"([^"]+)"', raw)
    if m:
        return m.group(1)
    m = re.search(r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", raw)  # JWT
    return m.group(0) if m else raw


def family_import(raw_token, steamid):
    token = _extract_token(raw_token)
    if not token:
        raise SteamError("family_token")
    try:
        g = http_json(
            "https://api.steampowered.com/IFamilyGroupsService/GetFamilyGroupForUser/v1/",
            {"access_token": token, "steamid": steamid},
        )
    except SteamError as e:
        if e.code in ("forbidden", "http"):
            raise SteamError("family_token") from e
        raise
    resp = (g or {}).get("response", {})
    gid = resp.get("family_groupid")
    if not gid or str(gid) == "0":
        raise SteamError("family_none")
    try:
        a = http_json(
            "https://api.steampowered.com/IFamilyGroupsService/GetSharedLibraryApps/v1/",
            {
                "access_token": token,
                "family_groupid": gid,
                "include_own": "true",
                "include_excluded": "true",
                "include_free": "true",
                "include_non_games": "false",
                "steamid": steamid,
            },
        )
    except SteamError as e:
        if e.code in ("forbidden", "http"):
            raise SteamError("family_token") from e
        raise
    apps = (a or {}).get("response", {}).get("apps") or []
    result = {}
    for app in apps:
        try:
            aid = int(app.get("appid"))
        except (TypeError, ValueError):
            continue
        result[str(aid)] = {"appid": aid, "name": app.get("name", "")}

    def fn(d):
        d["family"] = {"apps": result, "updated": int(time.time())}
    update(fn)
    return family_status()


def family_status():
    f = get()["family"]
    return {"count": len(f.get("apps", {})), "updated": f.get("updated", 0)}


def family_clear():
    def fn(d):
        d["family"] = {"apps": {}, "updated": 0}
    update(fn)


def excluded_ids():
    d = get()
    ids = {int(k) for k in d["hidden"]}
    ids |= {int(k) for k in d["family"].get("apps", {})}
    return ids
