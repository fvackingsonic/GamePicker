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
    min_price = f.get("min_price")
    min_price = float(min_price) if min_price not in (None, "") else None
    if min_price is not None and max_price is not None and min_price > max_price:
        min_price, max_price = max_price, min_price
    discount_only = bool(f.get("discount_only"))
    free_only = bool(f.get("free_only"))
    count = max(3, min(30, int(f.get("count") or 12)))
    cc, lang = f.get("cc", "ua"), f.get("lang", "ru")

    if mode == "tags" and not chosen:
        raise SteamError("no_tags")

    # игры, на которые нужно быть похожими: в режиме «games» — выбранные, иначе — топ библиотеки
    compare = profile["top"]
    compare_vecs = profile["vectors"]
    if mode == "games":
        seeds = []
        for sd in f.get("seeds", [])[:10]:
            try:
                sid = int(sd.get("appid") if isinstance(sd, dict) else sd)
            except (TypeError, ValueError):
                continue
            seeds.append((sid, sd.get("name", "") if isinstance(sd, dict) else ""))
        if not seeds:
            raise SteamError("no_seeds")
        hours = {g["appid"]: g["hours"] for g in games}
        compare, compare_vecs, target = [], {}, {}
        for i, (sid, sname) in enumerate(seeds):
            progress(0.03 * i / len(seeds), "seeds", sname or str(sid))
            try:
                spy = spy_app(sid)
            except SteamError:
                continue
            vec = tag_vector(spy.get("tags"))
            if not vec:
                continue
            compare.append({"appid": sid, "name": sname or spy.get("name") or str(sid), "hours": hours.get(sid)})
            compare_vecs[sid] = vec
            for t, v in vec.items():
                target[t] = target.get(t, 0.0) + v / len(seeds)
            skip.add(sid)
        if not target:
            raise SteamError("no_seed_tags")
        mx = max(target.values()) or 1.0
        target = {t: v / mx for t, v in sorted(target.items(), key=lambda kv: -kv[1])[:30]}
        for t in chosen:
            target[t] = max(target.get(t, 0.0), 1.0)
        # кандидаты: главные теги КАЖДОЙ выбранной игры, чтобы не потерять ни одну
        per_seed = []
        for c in compare:
            per_seed += [t for t in compare_vecs[c["appid"]] if t not in GENERIC and t not in excluded][:3]
        auto = [t for t in target if t not in GENERIC and t not in excluded]
        pool_tags = list(dict.fromkeys(chosen + per_seed + auto))[:max(POOL_TAGS, 3 * len(compare) + 1, 9)][:12]
    else:
        target = _target_vector(profile["tags"], mode, chosen)
    if mode == "games":
        pass
    elif mode == "tags":
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
    multi = mode == "games" and len(compare) > 1
    seed_mode = f.get("seed_mode") if f.get("seed_mode") in ("blend", "each") else "blend"
    shortlist = scored[: min(60, max(30, count * 3, 12 * len(compare) if multi else 0))]

    # 3. Подробности: теги (SteamSpy) + цена/описание в твоём регионе (магазин Steam)
    done = [0]

    def fetch(entry):
        aid = entry[1]
        progress(0.25 + 0.7 * done[0] / len(shortlist), "details", "")  # при отмене выходим сразу
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
        if min_price is not None and min_price > 0 and (final is None or final < min_price):
            continue

        rel = cosine(target, vec) if vec else 0.5 * pre
        sims = [cosine(vec, compare_vecs.get(g["appid"], {})) for g in compare]
        if multi and vec:
            if seed_mode == "blend":
                # должна быть похожа на ВСЕ выбранные: слабейшее сходство весит больше всего
                rel = 0.6 * min(sims) + 0.4 * (sum(sims) / len(sims))
            else:
                rel = max(sims)
        score = 0.55 * rel + 0.30 * q + 0.15 * extra

        # «почему тебе» — на какую игру (или игры) похоже
        best, best_sim = None, 0.0
        for g, sim in zip(compare, sims):
            if sim > best_sim:
                best, best_sim = g, sim
        why_games = [best] if best else []
        if multi and seed_mode == "blend" and best:
            why_games = [g for g, sim in sorted(zip(compare, sims), key=lambda x: -x[1])
                         if sim >= max(0.25, 0.7 * best_sim)]
        shared = []
        if why_games:
            common = set(vec)
            for g in why_games:
                common &= set(compare_vecs[g["appid"]])
            ov = compare_vecs[best["appid"]]
            shared = sorted(common, key=lambda t: -(vec[t] * ov.get(t, 0) * (0.3 if t in GENERIC else 1)))[:4]

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
                "games": [g["name"] for g in why_games],
                "hours": best["hours"] if best and len(why_games) <= 1 else None,
                "shared": shared,
                "similarity": round(best_sim, 2),
            },
            "gem": n < 5000,
            "score": round(score, 4),
            "_vec": vec,
            "_seed": best["appid"] if best else None,
        })

    # 4. Разнообразие (MMR): не выдаём 12 одинаковых игр
    picked = []
    pool = sorted(items, key=lambda x: -x["score"])

    def mmr(x):
        sim = max((cosine(x["_vec"], p["_vec"]) for p in picked), default=0.0)
        return x["score"] - 0.3 * sim

    if multi and seed_mode == "each":
        # по очереди: лучшая для первой игры, лучшая для второй… чтобы каждой досталось поровну
        buckets = [[x for x in pool if x["_seed"] == c["appid"]] for c in compare]
        while len(picked) < count and any(buckets):
            for b in buckets:
                if b and len(picked) < count:
                    nxt = max(b, key=mmr)
                    b.remove(nxt)
                    picked.append(nxt)
    else:
        while pool and len(picked) < count:
            nxt = max(pool, key=mmr)
            pool.remove(nxt)
            picked.append(nxt)
    for p in picked:
        p.pop("_vec", None)
        p.pop("_seed", None)
    progress(1.0, "rank", "")
    return {"items": picked, "pool_tags": pool_tags, "checked": len(cands)}


# ---------------------------------------------------------------- одна игра (из поиска)

def game_card(state, appid, cc="ua", lang="ru"):
    """Карточка любой игры Steam в том же виде, что и результаты подбора."""
    store = store_details(appid, cc, lang)
    if not store:
        raise SteamError("not_found", str(appid))
    try:
        spy = spy_app(appid)
    except SteamError:
        spy = {}
    all_tags = spy.get("tags") if isinstance(spy.get("tags"), dict) else {}
    vec = tag_vector(all_tags)
    pos, neg = _int(spy.get("positive")), _int(spy.get("negative"))
    n = pos + neg
    po = store.get("price_overview")
    is_free = bool(store.get("is_free"))

    best, best_sim, shared = None, 0.0, []
    profile = state.get("profile") if state else None
    owned = {g["appid"]: g["hours"] for g in (state.get("games") or [])} if state else {}
    if profile and vec:
        for g in profile["top"]:
            if g["appid"] == appid:
                continue
            sim = cosine(vec, profile["vectors"].get(g["appid"], {}))
            if sim > best_sim:
                best, best_sim = g, sim
        if best:
            ov = profile["vectors"][best["appid"]]
            shared = sorted(set(vec) & set(ov), key=lambda t: -(vec[t] * ov[t] * (0.3 if t in GENERIC else 1)))[:4]
    return {
        "appid": appid,
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
        "matched": [],
        "why": {
            "game": best["name"] if best and best_sim >= 0.3 else None,
            "games": [best["name"]] if best and best_sim >= 0.3 else [],
            "hours": best["hours"] if best and best_sim >= 0.3 else None,
            "shared": shared,
            "similarity": round(best_sim, 2),
        },
        "owned_hours": owned.get(appid),
        "gem": 0 < n < 5000,
        "lookup": True,
    }
