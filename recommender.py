"""Профиль вкусов по библиотеке и подбор игр."""
import math
import re
from concurrent.futures import ThreadPoolExecutor

from steam_api import SteamError, spy_app, spy_tag, store_details

# Теги, которые есть почти у всех игр и мало говорят о вкусе — их вес снижается.
GENERIC = {
    "Singleplayer", "Multiplayer", "Action", "Adventure", "Indie", "Casual", "Great Soundtrack",
    "Atmospheric", "Early Access", "Free to Play", "Classic", "Masterpiece", "Addictive", "Beautiful",
    "Funny", "Colorful", "Controller", "Moddable", "Replay Value", "Cute", "Family Friendly",
    "Fantasy", "Violent", "Gore", "3D", "2D", "First-Person", "Third Person", "Realistic",
    "Stylized", "Cartoony", "Female Protagonist", "Simulation", "Strategy", "RPG", "Mature",
    "Nudity", "Sexual Content", "Psychological Horror", "Dark", "Hand-drawn", "Old School",
    "Retro", "Difficult", "Story Rich",
}
GENERIC_WEIGHT = 0.35
PROFILE_GAMES = 20
POOL_TAGS = 6


def tag_vector(tags, top=20):
    if not isinstance(tags, dict) or not tags:
        return {}
    items = sorted(tags.items(), key=lambda kv: -kv[1])[:top]
    mx = items[0][1] or 1
    return {t: (v / mx) * (GENERIC_WEIGHT if t in GENERIC else 1.0) for t, v in items}


def cosine(a, b):
    if not a or not b:
        return 0.0
    dot = sum(v * b.get(k, 0.0) for k, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def wilson(pos, n, z=1.96):
    """Нижняя граница доверительного интервала доли положительных отзывов."""
    if n <= 0:
        return 0.0
    p = pos / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
    return (centre - margin) / denom


def owners_low(owners):
    m = re.match(r"\s*([\d,]+)", str(owners or ""))
    return int(m.group(1).replace(",", "")) if m else 0


def _int(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------- профиль

def build_profile(games, progress):
    played = [g for g in games if g["hours"] >= 1]
    played.sort(key=lambda g: -(g["hours"] + 3 * g["recent_hours"]))
    top = played[:PROFILE_GAMES]
    profile, vectors, full_tags = {}, {}, {}
    for i, g in enumerate(top):
        progress(i / max(1, len(top)), "profile", g["name"])
        try:
            d = spy_app(g["appid"])
        except SteamError:
            continue
        vec = tag_vector(d.get("tags"))
        if not vec:
            continue
        vectors[g["appid"]] = vec
        full_tags[g["appid"]] = list(vec)[:6]
        w = math.log1p(g["hours"]) + 0.7 * math.log1p(g["recent_hours"])
        for t, v in vec.items():
            profile[t] = profile.get(t, 0.0) + w * v
    mx = max(profile.values(), default=1.0) or 1.0
    profile = {t: round(v / mx, 4) for t, v in sorted(profile.items(), key=lambda kv: -kv[1])}
    return {
        "tags": profile,
        "vectors": vectors,
        "top": [dict(g, tags=full_tags.get(g["appid"], [])) for g in top],
    }


def library_summary(games, profile):
    total_hours = sum(g["hours"] for g in games)
    return {
        "game_count": len(games),
        "total_hours": round(total_hours),
        "unplayed": sum(1 for g in games if g["hours"] < 0.5),
        "top_games": profile["top"][:12],
        "top_tags": [{"tag": t, "w": w} for t, w in list(profile["tags"].items())[:30]],
    }


# ---------------------------------------------------------------- подбор

def _https(u):
    return ("https://" + u[7:]) if isinstance(u, str) and u.startswith("http://") else u


def media_of(store):
    """Скриншоты и трейлеры из appdetails. Трейлеры Steam теперь — HLS/DASH, mp4 бывает не всегда."""
    shots = [
        {"thumb": _https(s.get("path_thumbnail")), "full": _https(s.get("path_full"))}
        for s in (store.get("screenshots") or [])[:12] if s.get("path_full")
    ]
    movies = []
    for m in (store.get("movies") or [])[:4]:
        mp4 = m.get("mp4") or {}
        webm = m.get("webm") or {}
        direct = mp4.get("max") or mp4.get("480") or webm.get("max") or webm.get("480")
        hls = m.get("hls_h264")
        if not (direct or hls):
            continue
        movies.append({
            "name": m.get("name", ""),
            "thumb": _https(m.get("thumbnail")),
            "hls": _https(hls),
            "mp4": _https(direct),
            "highlight": bool(m.get("highlight", True)),
        })
    movies.sort(key=lambda x: not x["highlight"])
    return {"screenshots": shots, "movies": movies}


def _target_vector(profile_tags, mode, chosen):
    if mode == "tags" and chosen:
        target = {t: v * 0.35 for t, v in list(profile_tags.items())[:30]}
        for t in chosen:
            target[t] = 1.0
    else:
        target = dict(list(profile_tags.items())[:30])
        for t in chosen:
            target[t] = max(target.get(t, 0.0), 1.0)
    return target


def recommend(state, f, progress):
    games = state["games"]
    profile = state["profile"]
    owned = {g["appid"] for g in games}
    skip = owned | {int(x) for x in f.get("skip", []) if str(x).isdigit()}

    mode = f.get("mode", "library")
    chosen = [t for t in f.get("tags", []) if t]
    excluded = set(f.get("exclude_tags", []))
    match_all = f.get("match") == "all"
    gems = bool(f.get("gems"))
    min_rating = float(f.get("min_rating") or 0)
    min_reviews = int(f.get("min_reviews") or 0)
    max_price = f.get("max_price")
    max_price = float(max_price) if max_price not in (None, "") else None
    discount_only = bool(f.get("discount_only"))
    free_only = bool(f.get("free_only"))
    count = max(3, min(30, int(f.get("count") or 12)))
    cc, lang = f.get("cc", "ua"), f.get("lang", "ru")

    if mode == "tags" and not chosen:
        raise SteamError("no_tags")

    target = _target_vector(profile["tags"], mode, chosen)
    if mode == "tags":
        pool_tags = list(chosen)
    else:
        auto = [t for t in profile["tags"] if t not in GENERIC and t not in excluded]
        pool_tags = list(dict.fromkeys(chosen + auto[:POOL_TAGS]))
    if not pool_tags:
        raise SteamError("empty_profile")

    # 1. Пул кандидатов по тегам (SteamSpy)
    cands = {}
    for i, tag in enumerate(pool_tags):
        progress(0.25 * i / len(pool_tags), "pool", tag)
        try:
            rows = spy_tag(tag)
        except SteamError:
            continue
        for key, row in rows.items():
            if not isinstance(row, dict):
                continue
            aid = _int(row.get("appid", key))
            if not aid or aid in skip:
                continue
            c = cands.setdefault(aid, {"row": row, "hits": set()})
            c["hits"].add(tag)

    # 2. Быстрая предварительная оценка
    target_sum = sum(target.get(t, 0) for t in pool_tags) or 1.0
    scored = []
    for aid, c in cands.items():
        row = c["row"]
        pos, neg = _int(row.get("positive")), _int(row.get("negative"))
        n = pos + neg
        if n < max(min_reviews, 10):
            continue
        if n and pos * 100.0 / n < min_rating:
            continue
        if mode == "tags" and match_all and not set(chosen) <= c["hits"]:
            continue
        if free_only and (_int(row.get("price")) or _int(row.get("initialprice"))):
            continue
        own_low = owners_low(row.get("owners"))
        if gems and (n > 15000 or own_low > 1_000_000):
            continue
        rel = sum(target.get(t, 0) for t in c["hits"]) / target_sum
        q = wilson(pos, n)
        pop = min(1.0, math.log10(n + 1) / 5)
        extra = (1 - pop) if gems else pop * 0.5
        scored.append((0.55 * rel + 0.35 * q + 0.10 * extra, aid, q, extra, pos, n))
    if not scored:
        return {"items": [], "pool_tags": pool_tags, "checked": 0}
    scored.sort(reverse=True)
    shortlist = scored[: max(30, count * 3)]

    # 3. Подробности: теги (SteamSpy) + цена/описание в твоём регионе (магазин Steam)
    done = [0]

    def fetch(entry):
        aid = entry[1]
        try:
            spy = spy_app(aid)
        except SteamError:
            spy = {}
        try:
            store = store_details(aid, cc, lang)
        except SteamError:
            store = None
        done[0] += 1
        progress(0.25 + 0.7 * done[0] / len(shortlist), "details", store.get("name") if store else str(aid))
        return entry, spy, store

    with ThreadPoolExecutor(max_workers=4) as ex:
        details = list(ex.map(fetch, shortlist))

    progress(0.97, "rank", "")
    items = []
    for (pre, aid, q, extra, pos, n), spy, store in details:
        if not store or store.get("type") != "game":
            continue
        if (store.get("release_date") or {}).get("coming_soon"):
            continue
        all_tags = spy.get("tags") if isinstance(spy.get("tags"), dict) else {}
        vec = tag_vector(all_tags)
        if excluded & set(all_tags):
            continue
        if mode == "tags" and match_all and all_tags and not set(chosen) <= set(all_tags):
            continue
        po = store.get("price_overview")
        is_free = bool(store.get("is_free"))
        final = 0.0 if is_free else (po["final"] / 100 if po else None)
        if free_only and final != 0.0:
            continue
        if discount_only and not (po and po.get("discount_percent", 0) > 0):
            continue
        if max_price is not None and (final is None or final > max_price):
            continue

        rel = cosine(target, vec) if vec else 0.5 * pre
        score = 0.55 * rel + 0.30 * q + 0.15 * extra

        # «почему тебе» — самая похожая игра из библиотеки
        best, best_sim = None, 0.0
        for g in profile["top"]:
            sim = cosine(vec, profile["vectors"].get(g["appid"], {}))
            if sim > best_sim:
                best, best_sim = g, sim
        shared = []
        if best:
            ov = profile["vectors"][best["appid"]]
            common = sorted(set(vec) & set(ov), key=lambda t: -(vec[t] * ov[t] * (0.3 if t in GENERIC else 1)))
            shared = common[:4]

        items.append({
            "appid": aid,
            "name": store.get("name") or spy.get("name"),
            "image": store.get("header_image"),
            "description": store.get("short_description", ""),
            "developers": store.get("developers", [])[:2],
            "release": (store.get("release_date") or {}).get("date", ""),
            "genres": [g.get("description") for g in store.get("genres", [])][:3],
            "media": media_of(store),
            "price": {
                "is_free": is_free,
                "final": po.get("final_formatted") if po else None,
                "initial": po.get("initial_formatted") if po else None,
                "discount": po.get("discount_percent", 0) if po else 0,
                "available": is_free or po is not None,
            },
            "rating": round(pos * 100 / n) if n else None,
            "reviews": n,
            "owners": spy.get("owners", ""),
            "tags": list(all_tags)[:8],
            "matched": [t for t in chosen if t in all_tags],
            "why": {
                "game": best["name"] if best else None,
                "hours": best["hours"] if best else None,
                "shared": shared,
                "similarity": round(best_sim, 2),
            },
            "gem": n < 5000,
            "score": round(score, 4),
            "_vec": vec,
        })

    # 4. Разнообразие (MMR): не выдаём 12 одинаковых игр
    picked = []
    pool = sorted(items, key=lambda x: -x["score"])
    while pool and len(picked) < count:
        def mmr(x):
            sim = max((cosine(x["_vec"], p["_vec"]) for p in picked), default=0.0)
            return x["score"] - 0.3 * sim
        nxt = max(pool, key=mmr)
        pool.remove(nxt)
        picked.append(nxt)
    for p in picked:
        p.pop("_vec", None)
    progress(1.0, "rank", "")
    return {"items": picked, "pool_tags": pool_tags, "checked": len(cands)}
