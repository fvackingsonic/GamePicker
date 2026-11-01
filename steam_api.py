"""Клиенты Steam Web API, магазина Steam и SteamSpy с дисковым кэшем и ограничением частоты запросов."""
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, "cache")
UA = "SteamGamePicker/1.0 (local app)"

STORE_LANG = {"ru": "russian", "uk": "ukrainian", "en": "english"}


class SteamError(Exception):
    """code — машинный код ошибки (переводится в интерфейсе), detail — подробности."""

    def __init__(self, code, detail=""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


class Throttle:
    def __init__(self, interval):
        self.interval = interval
        self.lock = threading.Lock()
        self.last = 0.0

    def wait(self):
        with self.lock:
            delay = self.last + self.interval - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            self.last = time.monotonic()


# SteamSpy просит не чаще 1 запроса в секунду, магазин Steam ~200 запросов за 5 минут.
THROTTLES = {
    "steamspy.com": Throttle(1.05),
    "store.steampowered.com": Throttle(1.2),
    "api.steampowered.com": Throttle(0.2),
    "api.anthropic.com": Throttle(0.2),
}


def _cache_path(key):
    return os.path.join(CACHE_DIR, hashlib.sha1(key.encode("utf-8")).hexdigest() + ".json")


def cache_get(key, ttl):
    path = _cache_path(key)
    try:
        if time.time() - os.path.getmtime(path) < ttl:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
    except (OSError, ValueError):
        pass
    return None


def cache_set(key, value):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = _cache_path(key)
    tmp = path + f".{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False)
    os.replace(tmp, path)


def http_json(url, params=None, ttl=0, headers=None, data=None, retries=3, timeout=40):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    cache_key = url if data is None else url + "|" + data.decode("utf-8")
    if ttl:
        hit = cache_get(cache_key, ttl)
        if hit is not None:
            return hit
    host = urllib.parse.urlparse(url).hostname
    throttle = THROTTLES.get(host)
    last_err = None
    for attempt in range(retries):
        if throttle:
            throttle.wait()
        req = urllib.request.Request(
            url, data=data, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})}
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
            value = json.loads(raw) if raw.strip() else None
            if ttl and value is not None:
                cache_set(cache_key, value)
            return value
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503, 504):
                time.sleep((6 if e.code == 429 else 2) * (attempt + 1))
                continue
            if e.code in (401, 403):
                raise SteamError("forbidden", host) from e
            raise SteamError("http", f"{host} HTTP {e.code}") from e
        except (urllib.error.URLError, TimeoutError, ValueError, ConnectionError) as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise SteamError("network", f"{host}: {last_err}")


# ---------- Steam Web API ----------

def resolve_steamid(api_key, value):
    v = (value or "").strip()
    if not v:
        raise SteamError("profile_not_found")
    m = re.search(r"steamcommunity\.com/profiles/(\d{17})", v)
    if m:
        return m.group(1)
    if re.fullmatch(r"\d{17}", v):
        return v
    m = re.search(r"steamcommunity\.com/id/([^/?#]+)", v)
    vanity = m.group(1) if m else v.strip("/")
    try:
        d = http_json(
            "https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/",
            {"key": api_key, "vanityurl": vanity},
            ttl=30 * 86400,
        )
    except SteamError as e:
        if e.code == "forbidden":
            raise SteamError("bad_key") from e
        raise
    resp = (d or {}).get("response", {})
    if resp.get("success") == 1 and resp.get("steamid"):
        return resp["steamid"]
    raise SteamError("profile_not_found", vanity)


def owned_games(api_key, steamid):
    try:
        d = http_json(
            "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/",
            {
                "key": api_key,
                "steamid": steamid,
                "include_appinfo": 1,
                "include_played_free_games": 1,
                "format": "json",
            },
            ttl=3600,
        )
    except SteamError as e:
        if e.code == "forbidden":
            raise SteamError("bad_key") from e
        raise
    games = (d or {}).get("response", {}).get("games")
    if not games:
        raise SteamError("library_private")
    return [
        {
            "appid": int(g["appid"]),
            "name": g.get("name") or str(g["appid"]),
            "hours": round(g.get("playtime_forever", 0) / 60, 1),
            "recent_hours": round(g.get("playtime_2weeks", 0) / 60, 1),
            "last_played": g.get("rtime_last_played", 0),
        }
        for g in games
    ]


# ---------- SteamSpy (теги, оценки, владельцы) ----------

def spy_app(appid):
    d = http_json("https://steamspy.com/api.php", {"request": "appdetails", "appid": appid}, ttl=7 * 86400)
    return d if isinstance(d, dict) else {}


def spy_tag(tag):
    d = http_json("https://steamspy.com/api.php", {"request": "tag", "tag": tag}, ttl=3 * 86400, timeout=90)
    return d if isinstance(d, dict) else {}


# ---------- Магазин Steam ----------

def store_details(appid, cc="ua", lang="ru"):
    d = http_json(
        "https://store.steampowered.com/api/appdetails",
        {"appids": appid, "cc": cc, "l": STORE_LANG.get(lang, "english")},
        ttl=86400,
    )
    entry = (d or {}).get(str(appid)) or {}
    return entry.get("data") if entry.get("success") else None


def app_reviews(appid, language="all", num=100):
    d = http_json(
        f"https://store.steampowered.com/appreviews/{appid}",
        {
            "json": 1,
            "language": language,
            "filter": "all",
            "review_type": "all",
            "purchase_type": "all",
            "num_per_page": num,
        },
        ttl=3 * 86400,
    )
    return d or {}
