"""Живая проверка Steam перед сборкой: отзывы, магазин, скриншоты и трейлер через прокси приложения."""
import os
import sys
import threading
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app  # noqa: E402
import steam_api as s  # noqa: E402
import summarizer as m  # noqa: E402
from recommender import media_of  # noqa: E402

r = s.app_reviews(9200, "all", 20, "russian")
print("reviews", len(r["reviews"]), r["query_summary"].get("review_score_desc"), r["query_summary"].get("total_reviews"))
assert r["reviews"], "no reviews"

x = m.summarize(895400, "Deadside", "ru")
print("summary", x["pct"], x["total"], x["pros"], x["cons"])

media = None
for appid in (1145360, 413150, 892970):  # Hades, Stardew Valley, Valheim
    d = s.store_details(appid, "ua", "ru")
    raw_movies = (d or {}).get("movies") or []
    if raw_movies:
        print("movie keys", appid, sorted(raw_movies[0].keys()))
    media = media_of(d or {})
    print("media", appid, "screens", len(media["screenshots"]), "movies", len(media["movies"]))
    if media["movies"]:
        break
assert media and media["screenshots"], "no screenshots"
mv = media["movies"][0]
print("movie", mv)

srv = ThreadingHTTPServer(("127.0.0.1", 8799), app.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:8799"


def proxied(u):
    p = urllib.parse.urlparse(u)
    return f"{base}/media/{p.hostname}{p.path}" + (f"?{p.query}" if p.query else "")


def get(url, limit=None):
    with urllib.request.urlopen(url, timeout=60) as resp:
        data = resp.read(limit) if limit else resp.read()
        return resp.status, resp.headers.get("Content-Type"), data


if mv.get("mp4"):
    st, ct, data = get(proxied(mv["mp4"]), 200000)
    print("mp4", st, ct, len(data))
else:
    # CORS напрямую (для справки)
    try:
        req = urllib.request.Request(mv["hls"], headers={"Origin": "http://127.0.0.1:8765"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            print("direct CORS:", resp.headers.get("Access-Control-Allow-Origin"))
    except Exception as e:  # noqa: BLE001
        print("direct fetch failed:", e)
    url = proxied(mv["hls"])
    for depth in range(3):
        st, ct, data = get(url)
        text = data.decode("utf-8", "replace")
        print(f"playlist[{depth}]", st, ct, text[:300].replace("\n", " | "))
        lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
        assert lines, "empty playlist"
        nxt = urllib.parse.urljoin(url, lines[0])
        if ".m3u8" in lines[0]:
            url = nxt
            continue
        st, ct, seg = get(nxt, 300000)
        print("segment", st, ct, len(seg), nxt[:120])
        assert st in (200, 206) and len(seg) > 1000, "segment too small"
        break
print("CI CHECK OK")
