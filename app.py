"""GamePicker — локальный подборщик игр Steam по твоей библиотеке.

Запуск:  python app.py      → откроется http://127.0.0.1:8765
Никаких сторонних библиотек не нужно (только Python 3.9+).
"""
import json
import os
import sys
import threading
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from recommender import build_profile, library_summary, recommend
from steam_api import BASE_DIR, SteamError, owned_games, resolve_steamid
from summarizer import summarize

HOST, PORT = "127.0.0.1", int(os.environ.get("GAMEPICKER_PORT", "8765"))
STATIC = os.path.join(BASE_DIR, "static")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
DEFAULT_CONFIG = {
    "steam_api_key": "",
    "steam_profile": "",
    "country": "ua",
    "anthropic_api_key": "",
    "claude_model": "claude-haiku-5-5",
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
        return recommend(STATE, filters, inner)
    return run


# ---------------------------------------------------------------- HTTP

MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    server_version = "GamePicker/1.0"

    def log_message(self, fmt, *args):  # тише в консоли
        if "/api/job" not in (args[0] if args else ""):
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

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/api/config":
            return self._send(200, public_config(load_config()))
        if url.path == "/api/library":
            return self._send(200, {"summary": STATE["summary"]})
        if url.path == "/api/job":
            job = JOBS.get(q.get("id", ""))
            return self._send(200 if job else 404, job or {"error": "no_job"})
        if url.path == "/api/summary":
            cfg = load_config()
            try:
                appid = int(q.get("appid", "0"))
                res = summarize(appid, q.get("name", ""), q.get("lang", "ru"),
                                cfg["anthropic_api_key"], cfg["claude_model"])
                return self._send(200, res)
            except SteamError as e:
                return self._send(502, {"error": {"code": e.code, "detail": e.detail}})
            except ValueError:
                return self._send(400, {"error": {"code": "bad_request"}})
        if url.path.startswith("/api/"):
            return self._send(404, {"error": "not_found"})
        return self._static("index.html" if url.path == "/" else url.path)

    def do_POST(self):
        url = urlparse(self.path)
        body = self._body()
        if url.path == "/api/config":
            cfg = load_config()
            for k in ("steam_profile", "country", "claude_model"):
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
        if url.path == "/api/recommend":
            return self._send(200, {"job": start_job(job_recommend(body))})
        return self._send(404, {"error": "not_found"})


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}"
    print(f"GamePicker запущен: {url}  (Ctrl+C — остановить)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")


if __name__ == "__main__":
    main()
