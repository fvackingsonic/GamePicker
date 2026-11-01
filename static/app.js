"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function load(key, def) { try { const v = localStorage.getItem(key); return v === null ? def : JSON.parse(v); } catch { return def; } }
function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ } }

const S = {
  lang: load("gp.lang", "ru"),
  config: null,
  library: null,
  family: { count: 0, updated: 0 },
  mode: load("gp.mode", "library"),
  match: "any",
  tagState: load("gp.tags", {}),      // tag -> "inc" | "exc"
  hidden: [],                          // [{appid,name,image,reason,ts}] — хранится на диске
  hiddenFilter: "",
  shown: new Set(),
  results: [],
  meta: null,
  lastFilters: null,
  busy: false,
  tab: "picks",
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
const num = (n) => Number(n || 0).toLocaleString(S.lang === "en" ? "en-US" : "ru-RU");
const cdnCover = (id) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`;

function applyI18n() {
  document.documentElement.lang = S.lang;
  $$("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  $$(".lang button").forEach((b) => b.classList.toggle("on", b.dataset.lang === S.lang));
  $("#mode-hint").textContent = t(S.mode === "tags" ? "mode_tags_hint" : "mode_library_hint");
  renderLibrary();
  renderTags();
  renderResults();
  renderHidden();
  renderFamilyStatus();
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
  const known = I18N[S.lang][key] || I18N.en[key];
  const msg = known ? t(key) : `${t("err_generic")}: ${code || "?"}`;
  return e && e.detail && !known ? `${msg} (${e.detail})` : msg;
}

function showError(e) {
  const box = $("#error");
  if (!e) { box.hidden = true; return; }
  box.textContent = errText(e);
  box.hidden = false;
}

function showProgress(p, stage, detail) {
  $("#progress").hidden = false;
  $("#progress-bar").style.width = `${Math.max(4, Math.round((p || 0) * 100))}%`;
  $("#progress-text").textContent = t(`stage_${stage}`, { d: detail || "" });
}
const hideProgress = () => ($("#progress").hidden = true);

// ---------------------------------------------------------------- tabs
function setTab(tab) {
  S.tab = tab;
  $$(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $$(".tab").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));
  $("#view-picks").hidden = tab !== "picks";
  $("#view-hidden").hidden = tab !== "hidden";
  if (tab === "hidden") renderHidden();
}

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
  f.anthropic_workspace.value = c.anthropic_workspace || "";
  $("#settings-err").hidden = true;
  $("#family-msg").textContent = "";
  $("#settings-cancel").hidden = !c.configured;
  renderFamilyStatus();
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
    anthropic_workspace: f.anthropic_workspace.value.trim(),
  };
  if ((!body.steam_api_key && !S.config?.steam_key_mask) || !body.steam_profile) {
    $("#settings-err").textContent = t("err_not_configured");
    $("#settings-err").hidden = false;
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

async function importFamily() {
  const token = $("#family-token").value.trim();
  const msg = $("#family-msg");
  if (!token) { msg.textContent = t("err_family_token"); return; }
  $("#btn-family").disabled = true;
  msg.textContent = "…";
  try {
    S.family = await api("/api/family", { token });
    msg.textContent = t("family_done", { n: num(S.family.count) });
    $("#family-token").value = "";
    renderFamilyStatus();
    renderLibrary();
  } catch (e) {
    msg.textContent = errText(e);
  } finally {
    $("#btn-family").disabled = false;
  }
}

async function clearFamily() {
  S.family = await api("/api/family", { clear: true });
  $("#family-msg").textContent = t("family_cleared");
  renderFamilyStatus();
  renderLibrary();
}

function renderFamilyStatus() {
  $("#family-status").textContent = S.family.count ? t("family_status", { n: num(S.family.count) }) : "";
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
    if (e && ["bad_key", "not_configured", "profile_not_found"].includes(e.code)) openSettings();
  } finally {
    S.busy = false;
    $("#btn-find").disabled = false;
    hideProgress();
    renderResults();
  }
}

function renderLibrary() {
  const L = S.library;
  $("#lib-card").hidden = !L;
  if (!L) return;
  const fam = S.family.count ? t("taste_family", { n: num(S.family.count) }) : "";
  $("#taste-line").innerHTML = t("taste_line", { games: num(L.game_count), hours: num(L.total_hours), family: esc(fam) });
  const tags = L.top_tags.filter((x) => !["Singleplayer", "Multiplayer", "Indie", "Action", "Adventure"].includes(x.tag)).slice(0, 8);
  $("#lib-tags").innerHTML = tags.map((x) => `<button type="button" data-tag="${esc(x.tag)}" title="${esc(x.tag)}">${esc(tagName(x.tag))}</button>`).join("");
  $$("#lib-tags button").forEach((el) => el.addEventListener("click", () => cycleTag(el.dataset.tag, "inc")));
  $("#lib-games").innerHTML = L.top_games.slice(0, 10).map((g) =>
    `<li>${esc(g.name)} <span>${num(g.hours)} ${esc(t("h"))}</span></li>`).join("");
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
  filtered.sort((a, b) => (S.tagState[b] ? 1 : 0) - (S.tagState[a] ? 1 : 0));
  const box = $("#tag-chips");
  box.innerHTML = filtered.map((tag) => {
    const st = S.tagState[tag] || "";
    return `<button type="button" class="chip ${st} ${fav.has(tag) ? "fav" : ""}" data-tag="${esc(tag)}" title="${esc(tag)}" aria-pressed="${!!st}">${esc(tagName(tag))}</button>`;
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
  filters.skip = [...S.shown];
  filters.lang = S.lang;
  S.lastFilters = filters;
  S.busy = true;
  showError(null);
  $("#btn-find").disabled = true;
  $("#btn-more").hidden = true;
  if (!more) { S.results = []; }
  renderResults();
  try {
    const res = await runJob("/api/recommend", filters);
    if (!S.library) { const r = await api("/api/library"); S.library = r.summary; renderLibrary(); renderTags(); }
    res.items.forEach((g) => S.shown.add(g.appid));
    S.results = more ? [...S.results, ...res.items] : res.items;
    S.meta = res;
    $("#btn-more").hidden = res.items.length === 0;
  } catch (e) {
    showError(e);
  } finally {
    S.busy = false;
    $("#btn-find").disabled = false;
    hideProgress();
    renderResults();
  }
}

function priceHtml(p) {
  if (p.is_free) return esc(t("free"));
  if (!p.available) return `<span class="na">${esc(t("unavailable"))}</span>`;
  if (p.discount > 0) return `${esc(p.final)}<s>${esc(p.initial)}</s>`;
  return esc(p.final);
}

function renderResults() {
  const box = $("#results");
  box.innerHTML = "";
  const ph = $("#placeholder");
  ph.hidden = S.results.length > 0 || S.busy;
  const nothing = S.lastFilters && !S.results.length;
  $("#placeholder-title").textContent = t(nothing ? "empty_none" : "empty_title");
  $("#placeholder-text").textContent = t(nothing ? "empty" : "start_hint");
  $("#results-meta").textContent = S.meta && S.results.length ? t("checked", { n: num(S.meta.checked) }) : "";
  const wanted = new Set(Object.entries(S.tagState).filter(([, v]) => v === "inc").map(([k]) => k));
  const tpl = $("#ticket-tpl");

  for (const g of S.results) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const storeUrl = `https://store.steampowered.com/app/${g.appid}/`;
    $(".cover", el).href = storeUrl;
    const img = $(".cover img", el);
    img.src = g.image || cdnCover(g.appid);
    img.alt = g.name;

    const stickers = [];
    if (g.price.discount > 0) stickers.push(`<span class="sticker sale">−${g.price.discount}%</span>`);
    if (g.gem) stickers.push(`<span class="sticker gem">${esc(t("gem_badge"))}</span>`);
    $(".stickers", el).innerHTML = stickers.join("");

    $(".t-name", el).textContent = g.name;
    $(".t-sub", el).textContent = [g.developers?.[0], g.release].filter(Boolean).join(", ");
    const tmp = document.createElement("template");
    tmp.innerHTML = g.description || "";
    $(".t-desc", el).textContent = tmp.content.textContent.trim();

    if (g.why && g.why.game) {
      const shared = g.why.shared.map(tagName).join(", ");
      $(".note", el).innerHTML = esc(t("note_why", { game: g.why.game, h: num(g.why.hours) })) +
        (shared ? `<small>${esc(t("note_common", { tags: shared }))}</small>` : "");
    } else {
      $(".note", el).hidden = true;
    }
    $(".t-tags", el).innerHTML = g.tags.slice(0, 7).map((tag) =>
      `<span class="${wanted.has(tag) ? "hl" : ""}">${esc(tagName(tag))}</span>`).join("");

    $(".stub-price", el).innerHTML = priceHtml(g.price);
    const cls = g.rating >= 85 ? "g" : g.rating >= 70 ? "m" : "b";
    $(".stub-score", el).innerHTML = g.rating != null
      ? `<b class="${cls}">${g.rating}%</b>${esc(t("reviews_from", { n: num(g.reviews) }))}` : "";

    const sumBtn = $(".act-summary", el);
    sumBtn.textContent = t("what_players_say");
    sumBtn.addEventListener("click", () => toggleSummary(g, el));
    $(".act-steam", el).href = storeUrl;
    $(".act-app", el).href = `steam://store/${g.appid}`;
    $(".act-app", el).textContent = t("open_app");
    $(".act-owned", el).textContent = t("owned_btn");
    $(".act-owned", el).addEventListener("click", () => hideGame(g, "owned", el));
    $(".act-hide", el).textContent = t("not_interested");
    $(".act-hide", el).addEventListener("click", () => hideGame(g, "not_interested", el));
    if (g._summary) { $(".summary", el).hidden = false; $(".summary", el).innerHTML = summaryHtml(g._summary); sumBtn.textContent = t("hide_summary"); }
    box.appendChild(el);
  }
}

async function toggleSummary(g, el) {
  const box = $(".summary", el);
  const btn = $(".act-summary", el);
  if (!box.hidden) { box.hidden = true; g._summary = null; btn.textContent = t("what_players_say"); return; }
  box.hidden = false;
  box.innerHTML = `<span class="hint">${esc(t("loading_summary"))}</span>`;
  btn.disabled = true;
  try {
    const s = await api(`/api/summary?appid=${g.appid}&lang=${S.lang}&name=${encodeURIComponent(g.name)}`);
    g._summary = s;
    box.innerHTML = summaryHtml(s);
    btn.textContent = t("hide_summary");
  } catch (e) {
    box.innerHTML = `<div class="err">${esc(errText(e))}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function summaryHtml(s) {
  const parts = [];
  if (s.ai_error) parts.push(`<div class="err">${esc(t("ai_failed"))}</div>`);
  if (s.ai) {
    parts.push(`<h5>${esc(t("ai_summary"))}</h5><p>${esc(s.ai.summary)}</p>`);
    if (s.ai.pros?.length) parts.push(`<h5>${esc(t("praised"))}</h5><ul class="pros">${s.ai.pros.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
    if (s.ai.cons?.length) parts.push(`<h5>${esc(t("criticized"))}</h5><ul class="cons">${s.ai.cons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
    if (s.ai.who_for) parts.push(`<h5>${esc(t("who_for"))}</h5><p>${esc(s.ai.who_for)}</p>`);
    if (s.ai.who_not) parts.push(`<h5>${esc(t("who_not"))}</h5><p>${esc(s.ai.who_not)}</p>`);
  } else {
    parts.push(`<h5>${esc(t("praised"))}</h5><p>${s.pros.length ? s.pros.map(aspectName).map(esc).join(", ") : esc(t("nothing_special"))}</p>`);
    parts.push(`<h5>${esc(t("criticized"))}</h5><p>${s.cons.length ? s.cons.map(aspectName).map(esc).join(", ") : esc(t("nothing_special"))}</p>`);
  }
  if (s.median_hours) parts.push(`<h5>${esc(t("typical_playtime"))}</h5><p>~${s.median_hours} ${esc(t("h"))}</p>`);
  if (!s.ai && s.quotes?.pos) parts.push(`<h5>${esc(t("quote_pos"))}</h5><blockquote>${esc(s.quotes.pos)}</blockquote>`);
  if (!s.ai && s.quotes?.neg) parts.push(`<h5>${esc(t("quote_neg"))}</h5><blockquote>${esc(s.quotes.neg)}</blockquote>`);
  const stat = s.pct != null ? `${s.pct}% ${t("positive")}, ${num(s.total)} ${t("reviews_word")}. ` : "";
  parts.push(`<div class="src">${esc(stat)}${esc(s.ai ? "Claude" : t("source_local"))}</div>`);
  return parts.join("");
}

// ---------------------------------------------------------------- hidden
async function hideGame(g, reason, el) {
  try {
    const r = await api("/api/hidden", { appid: g.appid, name: g.name, image: g.image || "", reason });
    S.hidden = r.items;
  } catch (e) { showError(e); return; }
  el.classList.add("leaving");
  setTimeout(() => { S.results = S.results.filter((x) => x.appid !== g.appid); renderResults(); renderHidden(); }, 240);
}

async function unhide(appid) {
  S.hidden = (await api("/api/hidden/remove", { appid })).items;
  renderHidden();
}

async function unhideAll() {
  S.hidden = (await api("/api/hidden/remove", { all: true, reason: S.hiddenFilter || null })).items;
  renderHidden();
}

function renderHidden() {
  $("#hidden-count").textContent = S.hidden.length ? String(S.hidden.length) : "";
  if (S.tab !== "hidden") return;
  $$("#hidden-filter button").forEach((b) => b.classList.toggle("on", b.dataset.reason === S.hiddenFilter));
  const items = S.hidden.filter((x) => !S.hiddenFilter || x.reason === S.hiddenFilter);
  const fmt = new Intl.DateTimeFormat(S.lang === "en" ? "en-GB" : S.lang === "uk" ? "uk-UA" : "ru-RU", { day: "numeric", month: "long" });
  $("#hidden-list").innerHTML = items.map((x) => `
    <li>
      <a href="https://store.steampowered.com/app/${x.appid}/" target="_blank" rel="noopener"><img loading="lazy" alt="" src="${esc(x.image || cdnCover(x.appid))}"></a>
      <div>
        <div class="h-name"><a href="https://store.steampowered.com/app/${x.appid}/" target="_blank" rel="noopener">${esc(x.name || `App ${x.appid}`)}</a></div>
        <div class="h-meta"><span class="reason ${esc(x.reason)}">${esc(t("hf_" + x.reason))}</span>${x.ts ? esc(t("hidden_on", { date: fmt.format(new Date(x.ts * 1000)) })) : ""}</div>
      </div>
      <button class="btn-ink small" data-unhide="${x.appid}">${esc(t("restore"))}</button>
    </li>`).join("");
  $$("[data-unhide]").forEach((b) => b.addEventListener("click", () => unhide(Number(b.dataset.unhide))));
  $("#hidden-empty").hidden = items.length > 0;
  $("#btn-unhide-all").hidden = items.length === 0;
}

// ---------------------------------------------------------------- init
function bind() {
  $$(".lang button").forEach((b) => b.addEventListener("click", () => { S.lang = b.dataset.lang; store("gp.lang", S.lang); applyI18n(); }));
  $$(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("#btn-settings").addEventListener("click", openSettings);
  $("#settings-form").addEventListener("submit", (e) => saveSettings(e).catch((err) => { $("#settings-err").textContent = errText(err); $("#settings-err").hidden = false; }));
  $("#settings-cancel").addEventListener("click", () => $("#settings").close());
  $("#btn-family").addEventListener("click", importFamily);
  $("#btn-family-clear").addEventListener("click", clearFamily);
  $("#btn-refresh").addEventListener("click", loadLibrary);
  $("#btn-find").addEventListener("click", () => find(false));
  $("#btn-more").addEventListener("click", () => find(true));
  $("#btn-unhide-all").addEventListener("click", unhideAll);
  $("#tag-search").addEventListener("input", renderTags);
  $$("#hidden-filter button").forEach((b) => b.addEventListener("click", () => { S.hiddenFilter = b.dataset.reason; renderHidden(); }));
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
    S.family = await api("/api/family").catch(() => S.family);
    S.hidden = (await api("/api/hidden")).items;
    // перенос старого списка «Не интересно» из браузера на диск
    const legacy = load("gp.hidden", []);
    if (legacy.length) {
      S.hidden = (await api("/api/hidden/import", { appids: legacy })).items;
      store("gp.hidden", []);
    }
  } catch (e) { showError(e); return; }
  renderHidden();
  if (!S.config.configured) { openSettings(); return; }
  const r = await api("/api/library").catch(() => ({}));
  if (r.summary) { S.library = r.summary; renderLibrary(); renderTags(); }
  else loadLibrary();
}

init();
// пинг для exe-режима: сервер выключится, когда вкладку закроют
setInterval(() => fetch("/api/ping").catch(() => {}), 10000);
fetch("/api/ping").catch(() => {});
