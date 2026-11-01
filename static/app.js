"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function load(key, def) { try { const v = localStorage.getItem(key); return v === null ? def : JSON.parse(v); } catch { return def; } }
function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ } }

const S = {
  lang: load("gp.lang", "ru"),
  config: null,
  library: null,
  mode: load("gp.mode", "library"),
  match: "any",
  tagState: load("gp.tags", {}),        // tag -> "inc" | "exc"
  hidden: new Set(load("gp.hidden", [])),
  shown: new Set(),
  results: [],
  lastFilters: null,
  busy: false,
};

// ---------------------------------------------------------------- i18n
function t(key, vars) {
  const dict = I18N[S.lang] || I18N.ru;
  let s = dict[key] ?? I18N.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}
const tagName = (tag) => (TAG_I18N[S.lang] || {})[tag] || tag;
const aspectName = (a) => (I18N[S.lang].aspects || {})[a] || a;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function applyI18n() {
  document.documentElement.lang = S.lang;
  $$("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  $$(".lang button").forEach((b) => b.classList.toggle("on", b.dataset.lang === S.lang));
  $("#mode-hint").textContent = t(S.mode === "tags" ? "mode_tags_hint" : "mode_library_hint");
  renderLibrary();
  renderTags();
  renderHiddenInfo();
  renderResults();
}

// ---------------------------------------------------------------- API
async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw data.error || { code: "http" };
  return data;
}

async function runJob(path, body) {
  const { job } = await api(path, body);
  showProgress(0, "start", "");
  for (;;) {
    await new Promise((res) => setTimeout(res, 650));
    const j = await api(`/api/job?id=${job}`);
    showProgress(j.progress, j.stage, j.detail);
    if (j.status === "done") return j.result;
    if (j.status === "error") throw j.error;
  }
}

function errText(e) {
  const code = e && e.code;
  const key = `err_${code}`;
  const msg = I18N[S.lang][key] ? t(key) : `${t("err_generic")}: ${code || "?"}`;
  return e && e.detail && !I18N[S.lang][key] ? `${msg} (${e.detail})` : msg;
}

function showError(e) {
  const box = $("#error");
  if (!e) { box.hidden = true; return; }
  box.textContent = errText(e);
  box.hidden = false;
}

function showProgress(p, stage, detail) {
  $("#progress").hidden = false;
  $("#progress-bar").style.width = `${Math.round((p || 0) * 100)}%`;
  $("#progress-text").textContent = t(`stage_${stage}`, { d: detail || "" });
}
const hideProgress = () => ($("#progress").hidden = true);

// ---------------------------------------------------------------- settings
function openSettings() {
  const f = $("#settings-form");
  const c = S.config || {};
  f.steam_api_key.value = "";
  f.steam_api_key.placeholder = c.steam_key_mask ? `${c.steam_key_mask} (${t("key_saved")})` : "";
  f.steam_profile.value = c.steam_profile || "";
  f.country.value = c.country || "ua";
  f.anthropic_api_key.value = "";
  f.anthropic_api_key.placeholder = c.anthropic_key_mask ? `${c.anthropic_key_mask} (${t("key_saved")})` : "sk-ant-…";
  f.claude_model.value = c.claude_model || "claude-haiku-5-5";
  $("#settings-err").textContent = "";
  $("#settings-cancel").hidden = !c.configured;
  $("#settings").showModal();
}

async function saveSettings(ev) {
  ev.preventDefault();
  const f = ev.target;
  const body = {
    steam_api_key: f.steam_api_key.value.trim(),
    steam_profile: f.steam_profile.value.trim(),
    country: f.country.value,
    anthropic_api_key: f.anthropic_api_key.value.trim(),
    claude_model: f.claude_model.value.trim() || "claude-haiku-5-5",
  };
  if ((!body.steam_api_key && !S.config?.steam_key_mask) || !body.steam_profile) {
    $("#settings-err").textContent = t("err_not_configured");
    return;
  }
  S.config = await api("/api/config", body);
  $("#settings").close();
  S.library = null;
  S.results = [];
  S.shown.clear();
  renderResults();
  loadLibrary();
}

// ---------------------------------------------------------------- library
async function loadLibrary() {
  if (S.busy) return;
  S.busy = true;
  showError(null);
  $("#btn-find").disabled = true;
  try {
    S.library = await runJob("/api/library", {});
    renderLibrary();
    renderTags();
  } catch (e) {
    showError(e);
    if (e && (e.code === "bad_key" || e.code === "not_configured" || e.code === "profile_not_found")) openSettings();
  } finally {
    S.busy = false;
    $("#btn-find").disabled = false;
    hideProgress();
  }
}

function renderLibrary() {
  const L = S.library;
  $("#lib-card").hidden = !L;
  if (!L) return;
  $("#lib-stats").innerHTML = `
    <div><b>${L.game_count}</b><span>${esc(t("games"))}</span></div>
    <div><b>${L.total_hours.toLocaleString()}</b><span>${esc(t("hours_total"))}</span></div>
    <div><b>${L.unplayed}</b><span>${esc(t("unplayed"))}</span></div>`;
  const tags = L.top_tags.slice(0, 10);
  $("#lib-tags").innerHTML = tags.map((x) =>
    `<div class="b" data-tag="${esc(x.tag)}" title="${esc(x.tag)}"><span>${esc(tagName(x.tag))}</span><i style="width:${Math.max(4, x.w * 100)}%"></i></div>`).join("");
  $$("#lib-tags .b").forEach((el) => el.addEventListener("click", () => cycleTag(el.dataset.tag, "inc")));
  $("#lib-games").innerHTML = L.top_games.slice(0, 8).map((g) =>
    `<li>${esc(g.name)} <span>· ${g.hours} ${esc(t("h"))}</span></li>`).join("");
}

// ---------------------------------------------------------------- tags
function allTags() {
  const fav = S.library ? S.library.top_tags.map((x) => x.tag) : [];
  const set = new Set([...Object.keys(S.tagState), ...fav, ...POPULAR_TAGS]);
  return { list: [...set], fav: new Set(fav.slice(0, 20)) };
}

function renderTags() {
  const q = $("#tag-search").value.trim().toLowerCase();
  const { list, fav } = allTags();
  const filtered = list.filter((tag) => !q || tag.toLowerCase().includes(q) || tagName(tag).toLowerCase().includes(q));
  // выбранные — сверху
  filtered.sort((a, b) => (S.tagState[b] ? 1 : 0) - (S.tagState[a] ? 1 : 0));
  const box = $("#tag-chips");
  box.innerHTML = filtered.map((tag) => {
    const st = S.tagState[tag] || "";
    return `<button class="chip ${st} ${fav.has(tag) ? "fav" : ""}" data-tag="${esc(tag)}" title="${esc(tag)}">${esc(tagName(tag))}</button>`;
  }).join("");
  $$(".chip", box).forEach((el) => el.addEventListener("click", () => cycleTag(el.dataset.tag)));
  $("#match-wrap").hidden = !(S.mode === "tags" && Object.values(S.tagState).filter((v) => v === "inc").length > 1);
}

function cycleTag(tag, force) {
  const cur = S.tagState[tag];
  const next = force ? (cur === force ? undefined : force) : cur === undefined ? "inc" : cur === "inc" ? "exc" : undefined;
  if (next) S.tagState[tag] = next; else delete S.tagState[tag];
  store("gp.tags", S.tagState);
  renderTags();
}

// ---------------------------------------------------------------- recommend
function collectFilters() {
  const inc = Object.entries(S.tagState).filter(([, v]) => v === "inc").map(([k]) => k);
  const exc = Object.entries(S.tagState).filter(([, v]) => v === "exc").map(([k]) => k);
  const price = $("#f-price").value;
  return {
    mode: S.mode,
    tags: inc,
    exclude_tags: exc,
    match: S.match,
    max_price: price === "" ? null : Number(price),
    discount_only: $("#f-discount").checked,
    free_only: $("#f-free").checked,
    min_rating: Number($("#f-rating").value),
    min_reviews: Number($("#f-reviews").value || 0),
    gems: $("#f-gems").checked,
    count: Number($("#f-count").value || 12),
    lang: S.lang,
  };
}

async function find(more = false) {
  if (S.busy) return;
  if (!S.config?.configured) return openSettings();
  const filters = more && S.lastFilters ? { ...S.lastFilters } : collectFilters();
  if (filters.mode === "tags" && !filters.tags.length) return showError({ code: "no_tags" });
  if (!more) S.shown.clear();
  filters.skip = [...S.hidden, ...S.shown];
  filters.lang = S.lang;
  S.lastFilters = filters;
  S.busy = true;
  showError(null);
  $("#btn-find").disabled = true;
  $("#btn-more").hidden = true;
  if (!more) { S.results = []; renderResults(); }
  $("#placeholder").hidden = true;
  try {
    const res = await runJob("/api/recommend", filters);
    if (!S.library) { const r = await api("/api/library"); S.library = r.summary; renderLibrary(); renderTags(); }
    res.items.forEach((g) => S.shown.add(g.appid));
    S.results = more ? [...S.results, ...res.items] : res.items;
    S.meta = res;
    renderResults();
    $("#btn-more").hidden = res.items.length === 0;
  } catch (e) {
    showError(e);
  } finally {
    S.busy = false;
    $("#btn-find").disabled = false;
    hideProgress();
  }
}

function priceHtml(p) {
  if (p.is_free) return `<span>${esc(t("free"))}</span>`;
  if (!p.available) return `<span class="na">${esc(t("unavailable"))}</span>`;
  if (p.discount > 0) return `<span><span class="disc">−${p.discount}%</span>${esc(p.final)}</span><s>${esc(p.initial)}</s>`;
  return `<span>${esc(p.final)}</span>`;
}

function renderResults() {
  const box = $("#results");
  box.innerHTML = "";
  const tpl = $("#card-tpl");
  $("#placeholder").hidden = S.results.length > 0 || S.busy;
  if (S.lastFilters && !S.results.length && !S.busy) {
    $("#placeholder").textContent = t("empty");
  } else {
    $("#placeholder").textContent = t("start_hint");
  }
  $("#results-meta").textContent = S.meta && S.results.length ? t("checked", { n: S.meta.checked.toLocaleString() }) : "";
  const wanted = new Set(Object.entries(S.tagState).filter(([, v]) => v === "inc").map(([k]) => k));

  for (const g of S.results) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const storeUrl = `https://store.steampowered.com/app/${g.appid}/`;
    $(".cover", el).href = storeUrl;
    $(".cover img", el).src = g.image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`;
    $(".name", el).textContent = g.name;
    $(".price", el).innerHTML = priceHtml(g.price);
    const cls = g.rating >= 85 ? "g" : g.rating >= 70 ? "m" : "b";
    $(".meta", el).innerHTML = [
      g.rating != null ? `<span class="score ${cls}">${g.rating}% ${esc(t("positive"))}</span>` : "",
      `<span>${g.reviews.toLocaleString()} ${esc(t("reviews_word"))}</span>`,
      g.release ? `<span>${esc(g.release)}</span>` : "",
      g.gem ? `<span class="badge">💎 ${esc(t("gem_badge"))}</span>` : "",
    ].join("");
    // описание из магазина бывает с HTML — разбираем в <template> (там ничего не исполняется) и берём только текст
    const tmp = document.createElement("template");
    tmp.innerHTML = g.description || "";
    $(".desc", el).textContent = tmp.content.textContent.trim();
    if (g.why && g.why.game) {
      const shared = g.why.shared.map(tagName).join(", ");
      $(".why", el).innerHTML = `${esc(t("why"))} <b>${esc(g.why.game)}</b> (${g.why.hours} ${esc(t("h"))} ${esc(t("you_played"))})` +
        (shared ? `<br><span class="muted">${esc(t("common"))}: ${esc(shared)}</span>` : "") +
        (g.matched && g.matched.length ? `<br><span class="muted">${esc(t("matched"))}: ${esc(g.matched.map(tagName).join(", "))}</span>` : "");
    } else {
      $(".why", el).hidden = true;
    }
    $(".tags", el).innerHTML = g.tags.slice(0, 7).map((tag) =>
      `<span class="chip static ${wanted.has(tag) ? "hl" : ""}">${esc(tagName(tag))}</span>`).join("");

    const sumBtn = $(".act-summary", el);
    sumBtn.textContent = t("what_players_say");
    sumBtn.addEventListener("click", () => toggleSummary(g, el));
    $(".act-steam", el).href = storeUrl;
    $(".act-steam", el).textContent = t("open_steam");
    $(".act-app", el).href = `steam://store/${g.appid}`;
    $(".act-app", el).textContent = t("open_app");
    const hideBtn = $(".act-hide", el);
    hideBtn.textContent = t("not_interested");
    hideBtn.addEventListener("click", () => {
      S.hidden.add(g.appid);
      store("gp.hidden", [...S.hidden]);
      el.classList.add("leaving");
      setTimeout(() => { S.results = S.results.filter((x) => x.appid !== g.appid); renderResults(); renderHiddenInfo(); }, 200);
    });
    if (g._summary) { $(".summary", el).hidden = false; $(".summary", el).innerHTML = summaryHtml(g._summary); sumBtn.textContent = t("hide_summary"); }
    box.appendChild(el);
  }
}

async function toggleSummary(g, el) {
  const box = $(".summary", el);
  const btn = $(".act-summary", el);
  if (!box.hidden) { box.hidden = true; g._summary = null; btn.textContent = t("what_players_say"); return; }
  box.hidden = false;
  box.innerHTML = `<span class="muted">${esc(t("loading_summary"))}</span>`;
  btn.disabled = true;
  try {
    const s = await api(`/api/summary?appid=${g.appid}&lang=${S.lang}&name=${encodeURIComponent(g.name)}`);
    g._summary = s;
    box.innerHTML = summaryHtml(s);
    btn.textContent = t("hide_summary");
  } catch (e) {
    box.innerHTML = `<span class="err">${esc(errText(e))}</span>`;
  } finally {
    btn.disabled = false;
  }
}

function summaryHtml(s) {
  const parts = [];
  if (s.ai) {
    parts.push(`<h5>${esc(t("ai_summary"))}</h5><p style="margin:0">${esc(s.ai.summary)}</p>`);
    if (s.ai.pros?.length) parts.push(`<h5>${esc(t("praised"))}</h5><ul class="pros">${s.ai.pros.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
    if (s.ai.cons?.length) parts.push(`<h5>${esc(t("criticized"))}</h5><ul class="cons">${s.ai.cons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
    if (s.ai.who_for) parts.push(`<h5>${esc(t("who_for"))}</h5><div>${esc(s.ai.who_for)}</div>`);
    if (s.ai.who_not) parts.push(`<h5>${esc(t("who_not"))}</h5><div>${esc(s.ai.who_not)}</div>`);
  } else {
    parts.push(`<h5>${esc(t("praised"))}</h5><div>${s.pros.length ? s.pros.map(aspectName).map(esc).join(", ") : esc(t("nothing_special"))}</div>`);
    parts.push(`<h5>${esc(t("criticized"))}</h5><div>${s.cons.length ? s.cons.map(aspectName).map(esc).join(", ") : esc(t("nothing_special"))}</div>`);
  }
  if (s.median_hours) parts.push(`<h5>${esc(t("typical_playtime"))}</h5><div>~${s.median_hours} ${esc(t("h"))}</div>`);
  if (!s.ai && s.quotes?.pos) parts.push(`<h5>${esc(t("quote_pos"))}</h5><blockquote>${esc(s.quotes.pos)}</blockquote>`);
  if (!s.ai && s.quotes?.neg) parts.push(`<h5>${esc(t("quote_neg"))}</h5><blockquote>${esc(s.quotes.neg)}</blockquote>`);
  const stat = s.pct != null ? `${s.pct}% ${t("positive")} · ${Number(s.total).toLocaleString()} ${t("reviews_word")}` : "";
  parts.push(`<div class="src">${esc(stat)}${stat ? " · " : ""}${esc(s.ai ? "Claude" : t("source_local"))}</div>`);
  return parts.join("");
}

function renderHiddenInfo() {
  const box = $("#hidden-info");
  if (!S.hidden.size) { box.innerHTML = ""; return; }
  box.innerHTML = `${esc(t("hidden_count", { n: S.hidden.size }))} · <button class="link" id="reset-hidden">${esc(t("reset_hidden"))}</button>`;
  $("#reset-hidden").addEventListener("click", () => { S.hidden.clear(); store("gp.hidden", []); renderHiddenInfo(); });
}

// ---------------------------------------------------------------- init
function bind() {
  $$(".lang button").forEach((b) => b.addEventListener("click", () => { S.lang = b.dataset.lang; store("gp.lang", S.lang); applyI18n(); }));
  $("#btn-settings").addEventListener("click", openSettings);
  $("#settings-form").addEventListener("submit", (e) => saveSettings(e).catch((err) => ($("#settings-err").textContent = errText(err))));
  $("#settings-cancel").addEventListener("click", () => $("#settings").close());
  $("#btn-refresh").addEventListener("click", loadLibrary);
  $("#btn-find").addEventListener("click", () => find(false));
  $("#btn-more").addEventListener("click", () => find(true));
  $("#tag-search").addEventListener("input", renderTags);
  $$("#mode button").forEach((b) => b.addEventListener("click", () => {
    S.mode = b.dataset.mode; store("gp.mode", S.mode);
    $$("#mode button").forEach((x) => x.classList.toggle("on", x === b));
    $("#mode-hint").textContent = t(S.mode === "tags" ? "mode_tags_hint" : "mode_library_hint");
    renderTags();
  }));
  $$("#match-wrap button").forEach((b) => b.addEventListener("click", () => {
    S.match = b.dataset.match;
    $$("#match-wrap button").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("#f-rating").addEventListener("input", (e) => ($("#f-rating-v").textContent = `${e.target.value}%`));
  $("#f-free").addEventListener("change", (e) => { if (e.target.checked) { $("#f-discount").checked = false; $("#f-price").value = ""; } });
  $("#f-discount").addEventListener("change", (e) => { if (e.target.checked) $("#f-free").checked = false; });
}

async function init() {
  bind();
  $$("#mode button").forEach((x) => x.classList.toggle("on", x.dataset.mode === S.mode));
  applyI18n();
  try {
    S.config = await api("/api/config");
  } catch (e) { showError(e); return; }
  if (!S.config.configured) { openSettings(); return; }
  const r = await api("/api/library").catch(() => ({}));
  if (r.summary) { S.library = r.summary; renderLibrary(); renderTags(); }
  else loadLibrary();
}

init();
