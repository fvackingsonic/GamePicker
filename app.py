"""GamePicker — локальный подборщик игр Steam по твоей библиотеке.

Запуск:  python app.py      → откроется http://127.0.0.1:8765
Никаких сторонних библиотек не нужно (только Python 3.9+).
"""
import json
import re
import urllib.error
import urllib.parse
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

from recommender import build_profile, game_card, library_summary, recommend
import winctl
from steam_api import BASE_DIR, DATA_DIR, FROZEN, SteamError, owned_games, resolve_steamid
from summarizer import summarize
import userdata
import updater
from steam_api import store_search

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
APP_VERSION = "1.6.0"
if os.environ.get("GAMEPICKER_FAKE_VERSION") and "--after-update" not in sys.argv:
    APP_VERSION = os.environ["GAMEPICKER_FAKE_VERSION"]  # только для проверки обновления в сборке
LAST_PING = [0.0]
SERVER = {"srv": None}
WEBVIEW = {"active": False, "module": None, "extra": [], "main": None, "frameless": False}
TT = {"cache": {}, "lock": threading.Lock()}
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
    job = {"status": "running", "progress": 0.0, "stage": "start", "detail": "", "result": None, "error": None, "cancel": False}
    JOBS[job_id] = job

    def progress(p, stage, detail=""):
        if job["cancel"]:
            raise SteamError("cancelled")
        job.update(progress=round(min(1.0, max(0.0, p)), 3), stage=stage, detail=detail)

    def run():
        try:
            job["result"] = fn(progress)
            job["status"] = "done"
            job["progress"] = 1.0
        except SteamError as e:
            if e.code == "cancelled" or job["cancel"]:
                job.update(status="cancelled", error={"code": "cancelled"})
            else:
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
        if url.path == "/api/update":
            info = updater.check(APP_VERSION, force=q.get("force") == "1")
            return self._send(200, {**updater.public(info), "download": dict(updater.STATE)})
        if url.path == "/api/game":
            cfg = load_config()
            try:
                return self._send(200, game_card(STATE, int(q.get("appid", "0")), cfg["country"] or "ua", q.get("lang", "ru")))
            except SteamError as e:
                return self._send(404 if e.code == "not_found" else 502, {"error": {"code": e.code, "detail": e.detail}})
            except ValueError:
                return self._send(400, {"error": {"code": "bad_request"}})
        if url.path == "/api/tiktok":
            try:
                return self._send(200, {"ids": tiktok_ids(q.get("q", "").strip(), q.get("mode", "hidden"))})
            except SteamError as e:
                return self._send(200, {"ids": [], "error": e.code})
        if url.path == "/api/win":
            return self._send(200, {"frameless": WEBVIEW["frameless"] and WEBVIEW["active"], "rect": winctl.rect()})
        if url.path == "/api/search":
            term = q.get("q", "").strip()
            if len(term) < 2:
                return self._send(200, {"items": []})
            low = term.lower()
            mine = [
                {"appid": g["appid"], "name": g["name"], "hours": g["hours"],
                 "image": f"https://cdn.cloudflare.steamstatic.com/steam/apps/{g['appid']}/capsule_sm_120.jpg", "owned": True}
                for g in sorted(STATE["games"] or [], key=lambda g: -g["hours"]) if low in g["name"].lower()
            ][:6]
            cfg = load_config()
            try:
                store = store_search(term, cfg["country"] or "ua", q.get("lang", "ru"))
            except SteamError:
                store = []
            seen = {x["appid"] for x in mine}
            return self._send(200, {"items": mine + [x for x in store if x["appid"] not in seen][:10]})
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
        if url.path == "/api/job/cancel":
            job = JOBS.get(str(body.get("id", "")))
            if job and job["status"] == "running":
                job["cancel"] = True
            return self._send(200, {"ok": True})
        if url.path == "/api/win":
            act = body.get("action")
            if act == "min":
                winctl.minimize()
            elif act == "max":
                winctl.toggle_max()
            elif act == "close":
                threading.Thread(target=close_app, daemon=True).start()
            elif act == "rect":
                try:
                    winctl.set_rect(body["x"], body["y"], body["w"], body["h"])
                except (KeyError, TypeError, ValueError):
                    return self._send(400, {"error": {"code": "bad_request"}})
            return self._send(200, {"rect": winctl.rect()})
        if url.path == "/api/quit":
            def bye():
                time.sleep(0.3)
                for w in list(WEBVIEW["extra"]):
                    try:
                        w.destroy()
                    except Exception:  # noqa: BLE001
                        pass
                log("Закрываюсь по просьбе новой копии")
                os._exit(0)
            threading.Thread(target=bye, daemon=True).start()
            return self._send(200, {"ok": True})
        if url.path == "/api/update/download":
            try:
                return self._send(200, updater.start_download(APP_VERSION))
            except RuntimeError as e:
                return self._send(400, {"error": {"code": str(e)}})
        if url.path == "/api/update/apply":
            def before_exit():
                for w in WEBVIEW["extra"]:
                    try:
                        w.destroy()
                    except Exception:  # noqa: BLE001
                        pass
                if SERVER["srv"]:
                    try:
                        SERVER["srv"].shutdown()  # сначала остановить цикл, потом закрыть сокет
                    except Exception:  # noqa: BLE001
                        pass
                    SERVER["srv"].server_close()
            try:
                updater.apply_and_restart(before_exit)
                log(f"Обновление до {updater.STATE['version']}: перезапуск")
                return self._send(200, {"ok": True})
            except Exception as e:  # noqa: BLE001
                log("Не удалось применить обновление:\n" + traceback.format_exc())
                return self._send(500, {"error": {"code": "update_apply", "detail": str(e)}})
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


def close_app():
    time.sleep(0.15)
    for w in list(WEBVIEW["extra"]) + ([WEBVIEW["main"]] if WEBVIEW["main"] else []):
        try:
            w.destroy()
        except Exception:  # noqa: BLE001
            pass


TT_JS = "Array.from(document.querySelectorAll('a[href*=\"/video/\"]')).map(function(a){return a.href})"


TT_DIAG = "document.title + ' | ' + location.href + ' | a=' + document.querySelectorAll('a').length + ' | ' + (document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160) : '')"


def _tt_urls(query):
    """Публичные страницы TikTok, которые открываются без входа, и поиск (работает, если вход уже был)."""
    base = re.sub(r"\s*[:\-–—(].*$", "", query).strip() or query  # «Hades II: …» → «Hades II»
    words = re.sub(r"[^0-9a-zA-Zа-яА-ЯёЁіїєґІЇЄҐ]+", " ", base).strip().lower().split()
    tag = "".join(words)
    dashed = "-".join(words)
    urls = []
    if dashed:
        urls.append(f"https://www.tiktok.com/discover/{urllib.parse.quote(dashed)}-game")
    if tag:
        urls.append(f"https://www.tiktok.com/tag/{urllib.parse.quote(tag)}")
    if dashed:
        urls.append(f"https://www.tiktok.com/discover/{urllib.parse.quote(dashed)}")
    urls.append("https://www.tiktok.com/search/video?q=" + urllib.parse.quote(query))
    return urls


def _tt_scan(wv, url, mode):
    if mode == "offscreen":
        w = wv.create_window("GamePicker TikTok scan", url, width=480, height=1000, x=-6000, y=-6000,
                             focus=False, on_top=False)
    else:
        w = wv.create_window("GamePicker TikTok scan", url, width=480, height=1000, hidden=True)
    ids = []
    try:
        for i in range(22):
            time.sleep(2.5 if i == 0 else 0.6)
            try:
                hrefs = w.evaluate_js(TT_JS) or []
            except Exception:  # noqa: BLE001
                hrefs = []
            for h in hrefs:
                m = re.search(r"/video/(\d{8,})", str(h))
                if m and m.group(1) not in ids:
                    ids.append(m.group(1))
            if i in (0, 8, 21):
                try:
                    log(f"TikTok scan [{mode}] {url} #{i}: {w.evaluate_js(TT_DIAG)}")
                except Exception as e:  # noqa: BLE001
                    log(f"TikTok scan [{mode}] #{i}: diag error {e!r}")
            if len(ids) >= 30 or (ids and i >= 12):
                break
            if i % 3 == 2:
                try:
                    w.evaluate_js("window.scrollBy(0, 3000)")
                except Exception:  # noqa: BLE001
                    pass
    finally:
        try:
            w.destroy()
        except Exception:  # noqa: BLE001
            pass
    return ids


def tiktok_ids(query, mode="hidden"):
    """ID видео TikTok об игре. Страницу TikTok открываем в невидимом окне и собираем ссылки на видео,
    а играют они потом через официальный встраиваемый плеер TikTok (без входа и лайков)."""
    if not query:
        return []
    key = f"{mode}:{query.lower()}"
    hit = TT["cache"].get(key)
    if hit and time.time() - hit[0] < 6 * 3600 and hit[1]:
        return hit[1]
    if not WEBVIEW["active"] or not WEBVIEW["module"]:
        raise SteamError("no_window")
    with TT["lock"]:
        ids = []
        for url in _tt_urls(query):
            ids = _tt_scan(WEBVIEW["module"], url, mode)
            log(f"TikTok «{query}» {url}: видео {len(ids)}")
            if len(ids) >= 3:
                break
        TT["cache"][key] = (time.time(), ids)
        return ids


def free_port(preferred):
    for port in [preferred] + list(range(preferred + 1, preferred + 20)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if os.name != "nt":  # как у самого HTTP-сервера: порт после закрытой копии свободен сразу
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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
        frameless = os.name == "nt" and "--frame" not in sys.argv
        WEBVIEW["frameless"] = frameless
        win = webview.create_window("GamePicker", url, width=1360, height=900, min_size=(480, 600),
                                    background_color="#0f0f12", text_select=True,
                                    frameless=frameless, easy_drag=False)
        WEBVIEW["main"] = win
        if frameless:
            win.events.shown += lambda: threading.Timer(0.3, winctl.style_window).start()
        win.events.shown += shown.set
        WEBVIEW["module"] = webview
        win.events.shown += lambda: WEBVIEW.update(active=True)

        def on_main_closed():
            # главное окно закрыли — закрываем и окна TikTok, иначе программа продолжит жить без интерфейса
            WEBVIEW["active"] = False
            for w in list(WEBVIEW["extra"]):
                try:
                    w.destroy()
                except Exception:  # noqa: BLE001
                    pass
        win.events.closed += on_main_closed
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

    updater.cleanup_old()
    threading.Timer(6, updater.cleanup_old).start()  # после обновления старая копия закрывается не мгновенно
    if "--after-update" in sys.argv:  # ждём, пока старая версия освободит порт
        for _ in range(40):
            if not already_running(PORT):
                break
            time.sleep(0.25)
    if already_running(PORT):
        # Старая копия ещё жива (например, осталась висеть без окна) — просим её закрыться
        # и запускаем свой сервер. Подключаться к чужому серверу нельзя: он может выключиться.
        log("Найдена запущенная копия — прошу её закрыться")
        try:
            urllib.request.urlopen(urllib.request.Request(f"http://{HOST}:{PORT}/api/quit", data=b"{}",
                                                          headers={"Content-Type": "application/json"}), timeout=2)
        except Exception:  # noqa: BLE001
            pass
        for _ in range(24):
            if not already_running(PORT):
                break
            time.sleep(0.25)

    port = free_port(PORT)
    srv = ThreadingHTTPServer((HOST, port), Handler)
    SERVER["srv"] = srv
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
