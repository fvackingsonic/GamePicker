"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function load(key, def) { try { const v = localStorage.getItem(key); return v === null ? def : JSON.parse(v); } catch { return def; } }
function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ } }

const DEFAULT_F = { min_price: null, max_price: null, min_rating: 75, min_reviews: 100, discount_only: false, free_only: false, gems: false, count: 12, match: "any", seed_mode: "blend" };

const S = {
  lang: load("gp.lang", "ru"),
  theme: load("gp.theme", "auto"),
  view: "picks",
  mode: load("gp.mode", "library"),
  f: { ...DEFAULT_F, ...load("gp.filters", {}) },
  tagState: load("gp.tags", {}),          // tag -> "inc" | "exc"
  seeds: load("gp.seeds", []),            // [{appid,name,image}]
  config: null,
  library: null,
  family: { count: 0, updated: 0 },
  hidden: [],
  hiddenFilter: "",
  results: [],
  shown: new Set(),
  meta: null,
  lastFilters: null,
  busy: false,
  sel: null,                              // выбранная игра
  media: { items: [], i: 0, hls: null },
  sums: {},                               // appid -> сводка отзывов
  update: null,
  pop: null,
};

// ---------------------------------------------------------------- i18n и мелочи
function t(key, vars) {
  const dict = I18N[S.lang] || I18N.ru;
  let s = dict[key] ?? I18N.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}
const tagName = (tag) => (TAG_I18N[S.lang] || {})[tag] || tag;
const aspectName = (a) => (I18N[S.lang].aspects || I18N.en.aspects || {})[a] || a;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => Number(n || 0).toLocaleString(S.lang === "en" ? "en-US" : "ru-RU");
const CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps";
const ICON = {
  similar: '<svg viewBox="0 0 16 16"><path d="M8 1.5l1.4 3.6L13 6.5l-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4zM12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" fill="currentColor"/></svg>',
  owned: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 8.2l1.9 1.9 3.7-3.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  hide: '<svg viewBox="0 0 16 16"><path d="M2 8s2.2-4.2 6-4.2S14 8 14 8s-2.2 4.2-6 4.2S2 8 2 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
const actsHtml = (cls) => ["similar", "owned", "hide"].map((a) =>
  `<span role="button" tabindex="0" class="act" data-act="${a}" title="${esc(t("act_" + a))}" aria-label="${esc(t("act_" + a))}">${ICON[a]}</span>`).join("");
const headerImg = (id) => `${CDN}/${id}/header.jpg`;
const portraitImg = (id) => `${CDN}/${id}/library_600x900.jpg`;
const rateClass = (r) => (r >= 85 ? "g" : r >= 70 ? "m" : "b");
const saveF = () => store("gp.filters", S.f);
const listJoin = (arr) => (arr.length <= 1 ? arr.join("") : arr.slice(0, -1).join(", ") + ` ${t("and")} ` + arr[arr.length - 1]);

function applyI18n() {
  document.documentElement.lang = S.lang;
  $$("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  $$("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); el.setAttribute("aria-label", el.title); });
  $$("#lang button").forEach((b) => b.classList.toggle("on", b.dataset.lang === S.lang));
  applyTheme();
  renderChips();
  renderSeeds();
  renderGrid();
  renderSide();
  renderTaste();
  renderHidden();
  renderFamilyStatus();
  renderUpdate();
  renderStatus();
}

// ---------------------------------------------------------------- тема
const THEME_ICONS = {
  auto: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"/></g></svg>',
  dark: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="currentColor"/></svg>',
};
function applyTheme() {
  if (S.theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = S.theme;
  const b = $("#btn-theme");
  b.innerHTML = THEME_ICONS[S.theme];
  b.title = t(`theme_${S.theme}`);
  b.setAttribute("aria-label", b.title);
}
function cycleTheme() {
  S.theme = { auto: "dark", dark: "light", light: "auto" }[S.theme];
  store("gp.theme", S.theme);
  applyTheme();
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
  S.jobId = job;
  renderFindBtn();
  setProgress(0, "start", "");
  for (;;) {
    await new Promise((res) => setTimeout(res, 600));
    const j = await api(`/api/job?id=${job}`);
    setProgress(j.progress, j.stage, j.detail);
    if (j.status === "done") return j.result;
    if (j.status === "error" || j.status === "cancelled") throw j.error || { code: "cancelled" };
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

// ---------------------------------------------------------------- низ: статус и прогресс
let progressState = null;
function setProgress(p, stage, detail) {
  progressState = { p, stage, detail };
  renderStatus();
}
function renderStatus() {
  const st = $("#status");
  if (S.busy && progressState) {
    $("#prog").hidden = false;
    $("#prog-bar").style.width = `${Math.max(4, Math.round((progressState.p || 0) * 100))}%`;
    st.textContent = t(`stage_${progressState.stage}`, { d: progressState.detail || "" });
  } else {
    $("#prog").hidden = true;
    st.textContent = S.cancelled ? t("pick_cancelled") : S.meta && S.results.length ? t("checked", { n: num(S.meta.checked) }) : "";
  }
}

// ---------------------------------------------------------------- вкладки
function setView(v) {
  S.view = v;
  $$(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  $("#view-picks").hidden = v !== "picks";
  $("#view-taste").hidden = v !== "taste";
  $("#view-hidden").hidden = v !== "hidden";
  closePop();
  if (v === "taste") renderTaste();
  if (v === "hidden") renderHidden();
}

// ---------------------------------------------------------------- режим и фильтры
function setMode(mode) {
  S.mode = mode;
  store("gp.mode", mode);
  $$("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  renderSeeds();
  renderChips();
}

function priceLabel() {
  const { min_price: a, max_price: b, free_only: free } = S.f;
  if (free) return t("free");
  if (a != null && b != null) return `${num(a)}–${num(b)}`;
  if (a != null) return t("from_x", { x: num(a) });
  if (b != null) return t("to_x", { x: num(b) });
  return "";
}

function renderChips() {
  const inc = Object.entries(S.tagState).filter(([, v]) => v === "inc").map(([k]) => k);
  const exc = Object.entries(S.tagState).filter(([, v]) => v === "exc").length;
  const pv = priceLabel();
  $("#chip-price-v").textContent = pv;
  $('[data-pop="price"]').classList.toggle("on", !!pv);
  $("#chip-rating-v").textContent = `${S.f.min_rating}%+`;
  $('[data-pop="rating"]').classList.toggle("on", S.f.min_rating !== DEFAULT_F.min_rating || S.f.min_reviews !== DEFAULT_F.min_reviews);
  let tv = inc.length ? tagName(inc[0]) + (inc.length > 1 ? ` +${inc.length - 1}` : "") : "";
  if (exc) tv += (tv ? ", " : "") + t("excluded_n", { n: exc });
  $("#chip-tags-v").textContent = tv;
  $('[data-pop="tags"]').classList.toggle("on", !!tv);
  $('[data-toggle="discount_only"]').classList.toggle("on", !!S.f.discount_only);
  $('[data-toggle="gems"]').classList.toggle("on", !!S.f.gems);
  const moreOn = S.f.count !== DEFAULT_F.count;
  $("#chip-more-v").textContent = moreOn ? String(S.f.count) : "";
  $('[data-pop="more"]').classList.toggle("on", moreOn);
  const dirty = Object.keys(S.tagState).length > 0 || ["min_price", "max_price", "min_rating", "min_reviews", "discount_only", "free_only", "gems", "count", "match"].some((k) => S.f[k] !== DEFAULT_F[k]);
  $("#btn-reset").hidden = !dirty;
}

function resetFilters() {
  S.f = { ...DEFAULT_F, seed_mode: S.f.seed_mode };
  S.tagState = {};
  saveF();
  store("gp.tags", S.tagState);
  closePop();
  renderChips();
}

function toggleFlag(name) {
  S.f[name] = !S.f[name];
  if (name === "discount_only" && S.f.discount_only) S.f.free_only = false;
  saveF();
  renderChips();
}

// ---------------------------------------------------------------- всплывающие окошки
function closePop() {
  $("#pop").hidden = true;
  $$(".chip.open").forEach((c) => c.classList.remove("open"));
  S.pop = null;
}

function openPop(kind, anchor) {
  if (S.pop === kind) { closePop(); return; }
  closePop();
  S.pop = kind;
  anchor.classList.add("open");
  const pop = $("#pop");
  pop.innerHTML = POPS[kind]();
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
  pop.style.top = `${r.bottom + 8}px`;
  BIND[kind](pop);
  const first = $("input", pop);
  if (first && kind !== "more") first.focus();
}

const POPS = {
  price: () => `
    <h3>${esc(t("chip_price"))}</h3>
    <div class="row2">
      <label class="f"><small>${esc(t("from"))}</small><input type="number" min="0" id="p-min" value="${S.f.min_price ?? ""}" placeholder="0"></label>
      <label class="f"><small>${esc(t("to"))}</small><input type="number" min="0" id="p-max" value="${S.f.max_price ?? ""}" placeholder="∞"></label>
    </div>
    <div class="presets">
      <button data-p="free" class="${S.f.free_only ? "on" : ""}">${esc(t("free_only_short"))}</button>
      <button data-p="0-200">${esc(t("to_x", { x: 200 }))}</button>
      <button data-p="100-500">100–500</button>
      <button data-p="500-">${esc(t("from_x", { x: 500 }))}</button>
    </div>
    <div class="foot-row"><button class="link" data-p="reset">${esc(t("reset"))}</button><span class="hint">${esc(t("price_currency_hint"))}</span></div>`,
  rating: () => `
    <h3>${esc(t("min_rating"))}</h3>
    <div class="range"><input type="range" min="0" max="95" step="5" id="r-min" value="${S.f.min_rating}"><b id="r-min-v">${S.f.min_rating}%</b></div>
    <p class="sub">${esc(t("min_reviews"))}</p>
    <div class="presets">${[0, 50, 100, 500, 2000].map((n) => `<button data-rv="${n}" class="${S.f.min_reviews === n ? "on" : ""}">${n ? num(n) + "+" : t("any")}</button>`).join("")}</div>`,
  tags: () => `
    <h3>${esc(t("categories"))}</h3>
    <input class="tag-search" id="tag-q" placeholder="${esc(t("tag_search"))}">
    <p class="sub">${esc(t("tags_help"))}</p>
    <div class="tag-list" id="tag-list"></div>
    <div class="foot-row">
      <button class="link" id="tags-reset">${esc(t("reset"))}</button>
      <div class="seg" id="match"><button data-m="any" class="${S.f.match !== "all" ? "on" : ""}">${esc(t("match_any_short"))}</button><button data-m="all" class="${S.f.match === "all" ? "on" : ""}">${esc(t("match_all_short"))}</button></div>
    </div>`,
  more: () => `
    <h3>${esc(t("chip_more"))}</h3>
    <div class="switch-row"><span>${esc(t("free_only"))}</span><label class="tgl"><input type="checkbox" id="m-free" ${S.f.free_only ? "checked" : ""}><i></i></label></div>
    <div class="switch-row"><span>${esc(t("discount_only"))}</span><label class="tgl"><input type="checkbox" id="m-sale" ${S.f.discount_only ? "checked" : ""}><i></i></label></div>
    <div class="switch-row"><span>${esc(t("gems"))}<small>${esc(t("gems_hint"))}</small></span><label class="tgl"><input type="checkbox" id="m-gems" ${S.f.gems ? "checked" : ""}><i></i></label></div>
    <p class="sub">${esc(t("count"))}</p>
    <div class="presets">${[6, 12, 18, 24].map((n) => `<button data-c="${n}" class="${S.f.count === n ? "on" : ""}">${n}</button>`).join("")}</div>`,
};

const BIND = {
  price(pop) {
    const upd = () => {
      const a = $("#p-min", pop).value, b = $("#p-max", pop).value;
      S.f.min_price = a === "" ? null : Math.max(0, Number(a));
      S.f.max_price = b === "" ? null : Math.max(0, Number(b));
      if (S.f.min_price != null || S.f.max_price != null) S.f.free_only = false;
      saveF(); renderChips();
      $('[data-p="free"]', pop).classList.toggle("on", S.f.free_only);
    };
    $("#p-min", pop).addEventListener("input", upd);
    $("#p-max", pop).addEventListener("input", upd);
    $$("[data-p]", pop).forEach((b) => b.addEventListener("click", () => {
      const v = b.dataset.p;
      if (v === "free") { S.f.free_only = !S.f.free_only; S.f.min_price = S.f.max_price = null; S.f.discount_only = S.f.free_only ? false : S.f.discount_only; }
      else if (v === "reset") { S.f.free_only = false; S.f.min_price = S.f.max_price = null; }
      else { const [a, c] = v.split("-"); S.f.free_only = false; S.f.min_price = a ? Number(a) || null : null; S.f.max_price = c ? Number(c) : null; if (a === "0") S.f.min_price = null; }
      saveF(); renderChips();
      $("#pop").innerHTML = POPS.price(); BIND.price($("#pop"));
    }));
  },
  rating(pop) {
    $("#r-min", pop).addEventListener("input", (e) => { S.f.min_rating = Number(e.target.value); $("#r-min-v", pop).textContent = `${S.f.min_rating}%`; saveF(); renderChips(); });
    $$("[data-rv]", pop).forEach((b) => b.addEventListener("click", () => {
      S.f.min_reviews = Number(b.dataset.rv); saveF(); renderChips();
      $$("[data-rv]", pop).forEach((x) => x.classList.toggle("on", x === b));
    }));
  },
  tags(pop) {
    const draw = () => {
      const q = $("#tag-q", pop).value.trim().toLowerCase();
      const fav = S.library ? S.library.top_tags.map((x) => x.tag) : [];
      const all = [...new Set([...Object.keys(S.tagState), ...fav, ...POPULAR_TAGS])];
      const list = all.filter((tag) => !q || tag.toLowerCase().includes(q) || tagName(tag).toLowerCase().includes(q))
        .sort((a, b) => (S.tagState[b] ? 1 : 0) - (S.tagState[a] ? 1 : 0));
      const favSet = new Set(fav.slice(0, 15));
      $("#tag-list", pop).innerHTML = list.map((tag) =>
        `<button class="t-chip ${S.tagState[tag] || ""} ${favSet.has(tag) ? "fav" : ""}" data-tag="${esc(tag)}" title="${esc(tag)}">${esc(tagName(tag))}</button>`).join("");
      $$("[data-tag]", pop).forEach((b) => b.addEventListener("click", () => { cycleTag(b.dataset.tag); draw(); }));
    };
    $("#tag-q", pop).addEventListener("input", draw);
    $("#tags-reset", pop).addEventListener("click", () => { S.tagState = {}; store("gp.tags", S.tagState); renderChips(); draw(); });
    $$("[data-m]", pop).forEach((b) => b.addEventListener("click", () => {
      S.f.match = b.dataset.m; saveF();
      $$("[data-m]", pop).forEach((x) => x.classList.toggle("on", x === b));
    }));
    draw();
  },
  more(pop) {
    $("#m-free", pop).addEventListener("change", (e) => { S.f.free_only = e.target.checked; if (S.f.free_only) { S.f.discount_only = false; S.f.min_price = S.f.max_price = null; $("#m-sale", pop).checked = false; } saveF(); renderChips(); });
    $("#m-sale", pop).addEventListener("change", (e) => { S.f.discount_only = e.target.checked; if (S.f.discount_only) { S.f.free_only = false; $("#m-free", pop).checked = false; } saveF(); renderChips(); });
    $("#m-gems", pop).addEventListener("change", (e) => { S.f.gems = e.target.checked; saveF(); renderChips(); });
    $$("[data-c]", pop).forEach((b) => b.addEventListener("click", () => {
      S.f.count = Number(b.dataset.c); saveF(); renderChips();
      $$("[data-c]", pop).forEach((x) => x.classList.toggle("on", x === b));
    }));
  },
};

function cycleTag(tag, force) {
  const cur = S.tagState[tag];
  const next = force ? (cur === force ? undefined : force) : cur === undefined ? "inc" : cur === "inc" ? "exc" : undefined;
  if (next) S.tagState[tag] = next; else delete S.tagState[tag];
  store("gp.tags", S.tagState);
  renderChips();
}

// ---------------------------------------------------------------- поиск игр и выбранные игры
function renderSeeds() {
  const row = $("#seeds-row");
  row.hidden = S.mode !== "games";
  if (row.hidden) return;
  if (!S.seeds.length) { row.innerHTML = `<span class="hint-inline">${esc(t("seed_empty"))}</span>`; return; }
  const multi = S.seeds.length > 1;
  const sw = multi ? `<div class="seg small" id="seed-mode">
      <button data-sm="blend" class="${S.f.seed_mode !== "each" ? "on" : ""}" title="${esc(t("seed_blend_hint"))}">${esc(t("seed_blend"))}</button>
      <button data-sm="each" class="${S.f.seed_mode === "each" ? "on" : ""}" title="${esc(t("seed_each_hint"))}">${esc(t("seed_each"))}</button>
    </div>` : "";
  row.innerHTML = sw + `<span class="lbl">${esc(t(multi && S.f.seed_mode !== "each" ? "seeds_label_blend" : "seeds_label"))}</span>` + S.seeds.map((x) =>
    `<span class="seed"><img alt="" src="${esc(x.image || headerImg(x.appid))}">${esc(x.name)}<button type="button" data-rm="${x.appid}" aria-label="${esc(t("remove"))}">✕</button></span>`).join("");
  $$("[data-rm]", row).forEach((b) => b.addEventListener("click", () => removeSeed(Number(b.dataset.rm))));
  $$("[data-sm]", row).forEach((b) => b.addEventListener("click", () => { S.f.seed_mode = b.dataset.sm; saveF(); renderSeeds(); }));
}
function addSeed(g) {
  if (!S.seeds.some((x) => x.appid === g.appid)) S.seeds.push({ appid: g.appid, name: g.name, image: g.image || "" });
  S.seeds = S.seeds.slice(-10);
  store("gp.seeds", S.seeds);
  if (S.mode !== "games") setMode("games"); else renderSeeds();
}
function removeSeed(appid) {
  S.seeds = S.seeds.filter((x) => x.appid !== appid);
  store("gp.seeds", S.seeds);
  renderSeeds();
}

let seedFound = [];
let seedTimer = null;
async function searchSeeds() {
  const q = $("#seed-input").value.trim();
  const list = $("#seed-results");
  if (q.length < 2) { list.hidden = true; return; }
  try { seedFound = (await api(`/api/search?q=${encodeURIComponent(q)}&lang=${S.lang}`)).items; } catch { seedFound = []; }
  if ($("#seed-input").value.trim() !== q) return;
  list.innerHTML = seedFound.length
    ? seedFound.map((x, i) => `<li data-i="${i}" class="${i === 0 ? "on" : ""}" title="${esc(t("search_view"))}"><img alt="" src="${esc(x.image || headerImg(x.appid))}"><span>${esc(x.name)}</span>${x.owned ? `<small>${esc(t("seed_owned", { h: num(x.hours) }))}</small>` : ""}<button class="plus" data-plus="${i}" title="${esc(t("search_add"))}" aria-label="${esc(t("search_add"))}">+</button></li>`).join("")
    : `<li class="none">${esc(t("seed_none"))}</li>`;
  list.hidden = false;
  $$("li[data-i]", list).forEach((li) => li.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const i = Number(li.dataset.i);
    if (e.target.closest("[data-plus]")) pickSeed(i); else viewFound(i);
  }));
}
function pickSeed(i) {
  const x = seedFound[i];
  if (!x) return;
  addSeed(x);
  $("#seed-input").value = "";
  $("#seed-results").hidden = true;
}
async function viewFound(i) {
  const x = seedFound[i];
  if (!x) return;
  $("#seed-results").hidden = true;
  $("#seed-input").blur();
  setView("picks");
  const inGrid = S.results.find((g) => g.appid === x.appid);
  if (inGrid) { select(inGrid); return; }
  S.sel = { appid: x.appid, name: x.name, image: x.image, price: {}, media: { screenshots: [], movies: [] }, tags: [], loading: true };
  $$(".card").forEach((c) => c.classList.remove("on"));
  renderSide();
  try {
    const g = await api(`/api/game?appid=${x.appid}&lang=${S.lang}`);
    if (S.sel && S.sel.appid === g.appid) select(g);
  } catch (e) { showError(e); }
}

function seedKeys(e) {
  const items = $$("#seed-results li[data-i]");
  if (!items.length || $("#seed-results").hidden) return;
  let cur = items.findIndex((li) => li.classList.contains("on"));
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    cur = (cur + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((li, k) => li.classList.toggle("on", k === cur));
  } else if (e.key === "Enter") {
    e.preventDefault();
    const i = Number(items[Math.max(0, cur)].dataset.i);
    if (e.shiftKey || e.ctrlKey) pickSeed(i); else viewFound(i);
  } else if (e.key === "Escape") {
    $("#seed-results").hidden = true;
  }
}

// ---------------------------------------------------------------- подбор
function collectFilters() {
  const inc = Object.entries(S.tagState).filter(([, v]) => v === "inc").map(([k]) => k);
  const exc = Object.entries(S.tagState).filter(([, v]) => v === "exc").map(([k]) => k);
  return {
    ...S.f,
    mode: S.mode,
    tags: inc,
    exclude_tags: exc,
    seeds: S.seeds.map((x) => ({ appid: x.appid, name: x.name })),
    lang: S.lang,
  };
}

function renderFindBtn() {
  const b = $("#btn-find");
  b.disabled = false;
  b.classList.toggle("cancel", S.busy);
  b.textContent = S.busy ? t("cancel_pick") : t("find");
}

async function cancelJob() {
  if (S.jobId) await api("/api/job/cancel", { id: S.jobId }).catch(() => {});
}

async function find(more = false) {
  if (S.busy) { cancelJob(); return; }
  closePop();
  if (!S.config?.configured) return openSettings();
  const filters = more && S.lastFilters ? { ...S.lastFilters } : collectFilters();
  if (filters.mode === "tags" && !filters.tags.length) { openPop("tags", $('[data-pop="tags"]')); return showError({ code: "no_tags" }); }
  if (filters.mode === "games" && !filters.seeds.length) { $("#seed-input").focus(); return showError({ code: "no_seeds" }); }
  const prev = { results: S.results, sel: S.sel, shown: new Set(S.shown), meta: S.meta, last: S.lastFilters };
  if (!more) { S.shown.clear(); S.results = []; S.sel = null; }
  filters.skip = [...S.shown];
  filters.lang = S.lang;
  S.lastFilters = filters;
  S.busy = true;
  showError(null);
  renderFindBtn();
  $("#btn-more").hidden = true;
  renderGrid();
  renderSide();
  try {
    const res = await runJob("/api/recommend", filters);
    if (!S.library) { const r = await api("/api/library"); S.library = r.summary; renderTaste(); }
    res.items.forEach((g) => S.shown.add(g.appid));
    S.results = more ? [...S.results, ...res.items] : res.items;
    S.meta = res;
    $("#btn-more").hidden = res.items.length === 0;
    if (!S.sel && S.results.length) select(S.results[0]);
  } catch (e) {
    if (e && e.code === "cancelled") {
      S.results = prev.results; S.sel = prev.sel; S.shown = prev.shown; S.meta = prev.meta; S.lastFilters = prev.last;
      S.cancelled = true;
      $("#btn-more").hidden = !S.results.length;
    } else showError(e);
  } finally {
    S.busy = false;
    S.jobId = null;
    renderFindBtn();
    renderGrid();
    renderSide();
    renderStatus();
    S.cancelled = false;
  }
}

function priceText(p) {
  if (!p || p.available === undefined) return "";
  if (p.is_free) return t("free");
  if (!p.available) return t("unavailable_short");
  return p.final || "";
}

function coverHtml(g) {
  const badge = g.gem ? `<span class="badge">💎 ${esc(t("gem_badge"))}</span>` : "";
  return `<div class="cover">${badge}<div class="acts">${actsHtml()}</div><img class="main" alt="" loading="lazy" src="${esc(portraitImg(g.appid))}" data-fallback="${esc(g.image || headerImg(g.appid))}"></div>`;
}
function wireCovers(root) {
  $$("img.main[data-fallback]", root).forEach((img) => {
    img.addEventListener("error", () => {
      const fb = img.dataset.fallback;
      img.removeAttribute("data-fallback");
      const box = img.parentElement;
      box.classList.add("wide");
      const blur = document.createElement("img");
      blur.className = "blur"; blur.alt = ""; blur.src = fb;
      box.prepend(blur);
      img.src = fb;
    }, { once: true });
  });
}

function renderGrid() {
  const grid = $("#grid");
  const empty = $("#empty");
  if (S.busy && !S.results.length) {
    grid.innerHTML = Array.from({ length: 10 }, () => `<div class="card skeleton"><div class="cover"></div><div class="n"></div><div class="why"></div></div>`).join("");
    empty.hidden = true;
    $("#results-meta").textContent = "";
    return;
  }
  const nothing = S.lastFilters && !S.results.length;
  empty.hidden = S.results.length > 0;
  $("#empty-title").textContent = t(nothing ? "empty_none" : "empty_title");
  $("#empty-text").textContent = t(nothing ? "empty" : "start_hint");
  $("#results-meta").textContent = S.results.length ? metaLine() : "";
  grid.innerHTML = S.results.map((g, i) => {
    const pr = g.price;
    const sale = pr.discount > 0 ? `<span class="sale">−${pr.discount}%</span><s>${esc(pr.initial)}</s>` : "";
    const wg = (g.why && g.why.games) || [];
    const why = wg.length > 1 ? wg.join(" + ")
      : g.why && g.why.game ? t("card_why", { game: g.why.game }) + (g.why.hours ? `, ${num(g.why.hours)} ${t("h")}` : "") : (g.genres || []).join(", ");
    return `<button class="card ${S.sel && S.sel.appid === g.appid ? "on" : ""}" data-i="${i}">
      ${coverHtml(g)}
      <div class="n">${esc(g.name)}</div>
      <div class="why">${esc(why)}</div>
      <div class="pr">${sale}<b>${esc(priceText(pr))}</b>${g.rating != null ? `<span class="r ${rateClass(g.rating)}">${g.rating}%</span>` : ""}</div>
    </button>`;
  }).join("");
  wireCovers(grid);
  $$(".card[data-i]", grid).forEach((c) => c.addEventListener("click", (e) => {
    const g = S.results[Number(c.dataset.i)];
    const act = e.target.closest("[data-act]");
    if (act) { e.stopPropagation(); doAct(act.dataset.act, g); return; }
    select(g);
  }));
}

function metaLine() {
  const n = S.results.length;
  const lf = S.lastFilters || {};
  if (lf.mode === "games" && lf.seeds?.length > 1) return t(lf.seed_mode === "each" ? "meta_each" : "meta_blend", { n, games: listJoin(lf.seeds.map((x) => x.name).slice(0, 4)) });
  if (lf.mode === "games" && lf.seeds?.length) return t("meta_games", { n, games: lf.seeds[0].name });
  if (lf.mode === "tags") return t("meta_tags", { n, tags: (lf.tags || []).map(tagName).join(", ") });
  return t("meta_library", { n });
}

// ---------------------------------------------------------------- правая панель
let ttPrefetchTimer = null;
function select(g) {
  S.sel = g;
  clearTimeout(ttPrefetchTimer);
  if (g) ttPrefetchTimer = setTimeout(() => { if (S.sel === g) fetch(`/api/tiktok?prefetch=1&q=${encodeURIComponent(g.name)}`).catch(() => {}); }, 1500);
  $$(".card").forEach((c) => c.classList.toggle("on", S.results[Number(c.dataset.i)] === g));
  renderSide();
  if (g && !S.sums[g.appid]) loadSummary(g);
}

function mediaItems(g) {
  const m = g.media || { screenshots: [], movies: [] };
  const vids = (m.movies || []).map((v) => ({ type: "video", thumb: v.thumb, hls: v.hls, mp4: v.mp4, name: v.name }));
  const shots = (m.screenshots || []).map((s) => ({ type: "image", thumb: s.thumb, full: s.full }));
  return [...vids.slice(0, 1), ...shots, ...vids.slice(1)];
}

function renderSide() {
  const g = S.sel;
  $("#side-empty").hidden = !!g;
  $("#side-body").hidden = !g;
  stopHero();
  if (!g) return;
  S.media = { items: mediaItems(g), i: 0, hls: null };
  showHero(0, false);
  $("#strip").innerHTML = S.media.items.map((it, i) =>
    `<button class="${it.type === "video" ? "vid" : ""}" data-i="${i}"><img alt="" loading="lazy" src="${esc(it.thumb)}"></button>`).join("");
  $$("#strip button").forEach((b) => b.addEventListener("click", () => showHero(Number(b.dataset.i), true)));
  $("#side-body").scrollTop = 0;

  $("#s-title").textContent = g.name;
  $("#s-acts").innerHTML = actsHtml();
  $$("[data-act]", $("#s-acts")).forEach((b) => b.addEventListener("click", () => doAct(b.dataset.act, S.sel)));
  $("#s-dev").textContent = [g.developers?.[0], g.release].filter(Boolean).join(", ");
  const p = g.price;
  $("#s-price").innerHTML = esc(priceText(p)) + (p.discount > 0 ? `<s>${esc(p.initial)} −${p.discount}%</s>` : "");
  $("#s-steam").href = `https://store.steampowered.com/app/${g.appid}/`;
  $("#s-client").href = `steam://store/${g.appid}`;
  const tmp = document.createElement("template");
  tmp.innerHTML = g.description || "";
  $("#s-desc").textContent = tmp.content.textContent.trim();

  const facts = [];
  if (g.why && g.why.game) {
    const wg = g.why.games || [];
    const main = wg.length > 1 ? t("why_blend", { games: listJoin(wg) })
      : g.why.hours ? t("note_why", { game: g.why.game, h: num(g.why.hours) }) : t("note_why_seed", { game: g.why.game });
    facts.push(cell("blue", "★", t("why_you"), main));
  }
  if (g.rating != null) facts.push(cell(g.rating >= 85 ? "green" : g.rating >= 70 ? "amber" : "red", "✓", t("rating_line", { r: g.rating }), t("reviews_from", { n: num(g.reviews) })));
  if (g.owned_hours != null) facts.push(cell("green", "✓", t("owned_line"), t("owned_hours", { h: num(g.owned_hours) })));
  if (g.gem) facts.push(cell("violet", "💎", t("gems"), t("gem_line")));
  $("#s-facts").innerHTML = facts.join("");

  const wanted = new Set([...Object.entries(S.tagState).filter(([, v]) => v === "inc").map(([k]) => k), ...((g.why && g.why.shared) || [])]);
  $("#s-tags").innerHTML = (g.tags || []).slice(0, 8).map((tag) => `<span class="${wanted.has(tag) ? "hl" : ""}">${esc(tagName(tag))}</span>`).join("");
  renderReviews();
}

function cell(color, icon, title, sub, extra = "") {
  return `<div class="cell"><span class="dot ${color}">${icon}</span><div class="t">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>${extra}</div>`;
}

async function loadSummary(g) {
  S.sums[g.appid] = { loading: true };
  if (S.sel === g) renderReviews();
  try {
    S.sums[g.appid] = await api(`/api/summary?appid=${g.appid}&lang=${S.lang}&name=${encodeURIComponent(g.name)}`);
  } catch (e) {
    S.sums[g.appid] = { error: e };
  }
  if (S.sel === g) renderReviews();
}

function renderReviews() {
  const g = S.sel;
  const box = $("#s-reviews");
  if (!g) { box.innerHTML = ""; return; }
  const s = S.sums[g.appid];
  const head = `<div class="h">${esc(t("what_players_say"))}</div>`;
  if (!s || s.loading) { box.innerHTML = head + `<div class="cell load"><span class="dot gray">…</span><div class="t">${esc(t("loading_summary"))}</div></div>`; return; }
  if (s.error) {
    box.innerHTML = head + `<div class="cell"><span class="dot red">!</span><div class="t">${esc(errText(s.error))}${s.error.detail ? `<small>${esc(s.error.detail)}</small>` : ""}</div><button class="link" id="rv-retry">${esc(t("retry"))}</button></div>`;
    $("#rv-retry").addEventListener("click", () => loadSummary(g));
    return;
  }
  const rows = [];
  if (s.ai_error) rows.push(cell("amber", "!", t("ai_failed"), ""));
  if (s.ai) {
    rows.push(cell("blue", "✦", t("ai_summary"), s.ai.summary));
    if (s.ai.pros?.length) rows.push(cell("green", "+", t("praised"), s.ai.pros.join("; ")));
    if (s.ai.cons?.length) rows.push(cell("red", "−", t("criticized"), s.ai.cons.join("; ")));
    if (s.ai.who_for) rows.push(cell("violet", "♥", t("who_for"), s.ai.who_for));
    if (s.ai.who_not) rows.push(cell("gray", "✕", t("who_not"), s.ai.who_not));
  } else {
    rows.push(cell("green", "+", t("praised"), s.pros.length ? s.pros.map(aspectName).join(", ") : t("nothing_special")));
    rows.push(cell("red", "−", t("criticized"), s.cons.length ? s.cons.map(aspectName).join(", ") : t("nothing_special")));
  }
  if (s.median_hours) rows.push(cell("amber", "◷", t("typical_playtime"), `~${s.median_hours} ${t("h")}`));
  if (!s.ai && s.quotes?.pos) rows.push(`<div class="cell quote"><span class="dot green">“</span><div class="t">${esc(s.quotes.pos)}</div></div>`);
  if (!s.ai && s.quotes?.neg) rows.push(`<div class="cell quote"><span class="dot red">“</span><div class="t">${esc(s.quotes.neg)}</div></div>`);
  box.innerHTML = head + rows.join("");
}

// ---------- медиа в панели
let hlsPromise = null;
function loadHls() {
  if (window.Hls) return Promise.resolve();
  if (!hlsPromise) {
    hlsPromise = new Promise((resolve, reject) => {
      const add = (src, onerr) => { const s = document.createElement("script"); s.src = src; s.onload = resolve; s.onerror = onerr; document.head.appendChild(s); };
      add("/vendor/hls.min.js", () => add("https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js", () => { hlsPromise = null; reject(new Error("hls.js")); }));
    });
  }
  return hlsPromise;
}
const viaProxy = (u) => { const m = /^https?:\/\/([^/]+)\/(.*)$/.exec(u || ""); return m ? `/media/${m[1]}/${m[2]}` : u; };

function stopHero() {
  if (S.media.hls) { try { S.media.hls.destroy(); } catch { /* ignore */ } S.media.hls = null; }
  const v = $("#hero video");
  if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
}

async function attachVideo(video, it, holder) {
  try {
    if (it.mp4) video.src = it.mp4;
    else if (video.canPlayType("application/vnd.apple.mpegurl")) video.src = viaProxy(it.hls);
    else {
      await loadHls();
      if (!window.Hls || !window.Hls.isSupported()) throw new Error("hls");
      const h = new window.Hls({ maxBufferLength: 20 });
      holder.hls = h;
      h.on(window.Hls.Events.ERROR, (_e, d) => { if (d && d.fatal) video.dispatchEvent(new Event("error")); });
      h.loadSource(viaProxy(it.hls));
      h.attachMedia(video);
    }
    await video.play().catch(() => {});
  } catch {
    video.dispatchEvent(new Event("error"));
  }
}

function showHero(i, play) {
  stopHero();
  const items = S.media.items;
  const hero = $("#hero");
  hero.classList.remove("playing");
  S.media.i = i;
  $$("#strip button").forEach((b, k) => b.classList.toggle("on", k === i));
  const g = S.sel;
  const expand = `<button class="expand" title="${esc(t("fullscreen"))}" aria-label="${esc(t("fullscreen"))}">⤢</button>`;
  if (!items.length) { hero.innerHTML = `<img alt="" src="${esc(g.image || headerImg(g.appid))}">`; return; }
  const it = items[i];
  if (it.type === "image") {
    hero.innerHTML = `<img alt="" src="${esc(it.full)}">${expand}`;
  } else if (!play) {
    hero.innerHTML = `<img alt="" src="${esc(it.thumb || g.image)}"><button class="play" aria-label="${esc(t("trailer"))}"></button>${expand}`;
    $(".play", hero).addEventListener("click", () => showHero(i, true));
  } else {
    hero.classList.add("playing");
    hero.innerHTML = `<video controls playsinline poster="${esc(it.thumb || "")}"></video>${expand}`;
    const video = $("video", hero);
    video.addEventListener("error", () => { stopHero(); hero.innerHTML = `<img alt="" src="${esc(it.thumb || g.image)}"><div class="err">${esc(t("video_error"))}</div>`; }, { once: true });
    attachVideo(video, it, S.media);
  }
  const ex = $(".expand", hero);
  if (ex) ex.addEventListener("click", () => { stopHero(); openViewer(g, i); });
}

// ---------- действия
function doAct(act, g) {
  if (!g) return;
  if (act === "similar") { addSeed({ appid: g.appid, name: g.name, image: g.image }); find(false); }
  else if (act === "owned") hideGame(g, "owned");
  else if (act === "hide") hideGame(g, "not_interested");
}

const TT = { ids: [], vids: [], i: 0, game: null, wheelAt: 0, errAt: 0 };
const ttPlayer = (id) => `https://www.tiktok.com/player/v1/${id}?autoplay=1&loop=1&music_info=0&description=1&rel=0&controls=1&progress_bar=1&play_button=1&volume_control=1&fullscreen_button=0&timestamp=1&native_context_menu=0&closed_caption=0`;

async function openTikTok(g) {
  TT.game = g; TT.ids = []; TT.vids = []; TT.i = 0;
  $("#tt-meta").textContent = "";
  $("#tt-title").textContent = `TikTok: ${g.name}`;
  $("#tt-count").textContent = "";
  $("#tt-phone").innerHTML = `<div class="tt-msg"><div class="tt-spin"></div>${esc(t("tt_loading"))}</div>`;
  $("#tt-prev").disabled = $("#tt-next").disabled = true;
  if (!$("#tt").open) $("#tt").showModal();
  let r = { ids: [] };
  try { r = await api(`/api/tiktok?q=${encodeURIComponent(g.name)}`); } catch { /* ниже запасной путь */ }
  if (TT.game !== g || !$("#tt").open) return;
  if (!r.ids || !r.ids.length) {
    const url = `https://www.tiktok.com/search/video?q=${encodeURIComponent(g.name)}`;
    $("#tt-phone").innerHTML = `<div class="tt-msg">${esc(t(r.error === "no_window" ? "tt_browser" : "tt_none"))}<br><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${esc(t("tt_open_site"))}</a></div>`;
    return;
  }
  TT.vids = r.videos || r.ids.map((id) => ({ id }));
  TT.ids = TT.vids.map((v) => v.id);
  showTT(0);
}
function showTT(i) {
  if (!TT.ids.length) return;
  TT.i = Math.max(0, Math.min(TT.ids.length - 1, i));
  $("#tt-phone").innerHTML = `<iframe src="${ttPlayer(TT.ids[TT.i])}" allow="autoplay; encrypted-media; fullscreen" referrerpolicy="strict-origin-when-cross-origin" title="TikTok"></iframe>`;
  $("#tt-count").textContent = `${TT.i + 1} / ${TT.ids.length}`;
  const v = TT.vids[TT.i] || {};
  const parts = [];
  if (v.ts) parts.push(ago(v.ts));
  if (v.views) parts.push(`♥ ${compact(v.views)}`);
  $("#tt-meta").textContent = parts.join("   ");
  $("#tt-meta").classList.toggle("old", !!v.old);
  $("#tt-prev").disabled = TT.i === 0;
  $("#tt-next").disabled = TT.i === TT.ids.length - 1;
}
function compact(n) {
  return new Intl.NumberFormat(S.lang === "en" ? "en" : S.lang === "uk" ? "uk" : "ru", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
function ago(ts) {
  const d = Math.max(0, Date.now() / 1000 - ts);
  const rtf = new Intl.RelativeTimeFormat(S.lang === "en" ? "en" : S.lang === "uk" ? "uk" : "ru", { numeric: "auto" });
  if (d < 86400) return rtf.format(-Math.round(d / 3600), "hour");
  if (d < 86400 * 30) return rtf.format(-Math.round(d / 86400), "day");
  if (d < 86400 * 365) return rtf.format(-Math.round(d / (86400 * 30)), "month");
  return rtf.format(-Math.round(d / (86400 * 365)), "year");
}
// плеер TikTok сообщает о своих событиях через postMessage: при ошибке листаем дальше сами
window.addEventListener("message", (e) => {
  if (!/tiktok\.com$/.test(new URL(e.origin || "http://x").hostname) || !$("#tt").open) return;
  let d = e.data;
  try { if (typeof d === "string") d = JSON.parse(d); } catch { return; }
  const type = d && (d.type || d.event);
  if (type === "onError" || type === "error") {
    const now = Date.now();
    if (now - TT.errAt < 800) return;
    TT.errAt = now;
    if (TT.i < TT.ids.length - 1) showTT(TT.i + 1);
  }
});
function closeTT() { $("#tt-phone").innerHTML = ""; TT.game = null; if ($("#tt").open) $("#tt").close(); }

async function hideGame(g, reason) {
  try { S.hidden = (await api("/api/hidden", { appid: g.appid, name: g.name, image: g.image || "", reason })).items; }
  catch (e) { showError(e); return; }
  const idx = S.results.indexOf(g);
  if (idx < 0) { S.sel = null; renderSide(); renderHidden(); return; }
  const card = $(`.card[data-i="${idx}"]`);
  if (card) card.classList.add("leaving");
  setTimeout(() => {
    S.results = S.results.filter((x) => x !== g);
    if (S.sel === g) S.sel = S.results[Math.min(idx, S.results.length - 1)] || null;
    renderGrid(); renderSide(); renderHidden();
    if (S.sel && !S.sums[S.sel.appid]) loadSummary(S.sel);
  }, 200);
}

// ---------------------------------------------------------------- полноэкранный просмотр
const V = { game: null, items: [], i: 0, hls: null };
function stopViewer() {
  if (V.hls) { try { V.hls.destroy(); } catch { /* ignore */ } V.hls = null; }
  const v = $("#viewer-media video");
  if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
}
function openViewer(g, index) {
  V.game = g;
  V.items = mediaItems(g);
  if (!V.items.length) return;
  $("#viewer-title").textContent = g.name;
  $("#viewer-thumbs").innerHTML = V.items.map((it, i) =>
    `<button class="${it.type === "video" ? "vid" : ""}" data-i="${i}"><img alt="" loading="lazy" src="${esc(it.thumb)}"></button>`).join("");
  $$("#viewer-thumbs button").forEach((b) => b.addEventListener("click", () => showViewer(Number(b.dataset.i))));
  if (!$("#viewer").open) $("#viewer").showModal();
  showViewer(index);
}
function showViewer(i) {
  stopViewer();
  V.i = Math.max(0, Math.min(V.items.length - 1, i));
  const it = V.items[V.i];
  const box = $("#viewer-media");
  const shots = V.items.filter((x) => x.type === "image");
  $("#viewer-count").textContent = it.type === "video" ? `${t("trailer")}${it.name ? ": " + it.name : ""}` : t("screenshot_n", { i: shots.indexOf(it) + 1, n: shots.length });
  $$("#viewer-thumbs button").forEach((b, k) => b.classList.toggle("on", k === V.i));
  $("#viewer-thumbs button.on")?.scrollIntoView({ block: "nearest", inline: "center" });
  $("#viewer-prev").disabled = V.i === 0;
  $("#viewer-next").disabled = V.i === V.items.length - 1;
  if (it.type === "image") { box.innerHTML = `<img alt="" src="${esc(it.full)}">`; return; }
  box.innerHTML = `<video controls playsinline poster="${esc(it.thumb || "")}"></video>`;
  const video = $("video", box);
  video.addEventListener("error", () => {
    stopViewer();
    box.innerHTML = `<p class="viewer-err">${esc(t("video_error"))}<br><a href="https://store.steampowered.com/app/${V.game.appid}/" target="_blank" rel="noopener">${esc(t("open_steam"))}</a></p>`;
  }, { once: true });
  attachVideo(video, it, V);
}
function closeViewer() { stopViewer(); if ($("#viewer").open) $("#viewer").close(); }

// ---------------------------------------------------------------- «Мой вкус»
function renderTaste() {
  const L = S.library;
  if (!L) {
    $("#taste-line").textContent = t("taste_empty");
    $("#taste-tags").innerHTML = "";
    $("#taste-games").innerHTML = "";
    return;
  }
  const fam = S.family.count ? t("taste_family", { n: num(S.family.count) }) : "";
  $("#taste-line").innerHTML = t("taste_line2", { games: num(L.game_count), hours: num(L.total_hours), family: esc(fam), unplayed: num(L.unplayed) });
  $("#taste-tags").innerHTML = L.top_tags.slice(0, 24).map((x) =>
    `<button data-tag="${esc(x.tag)}" title="${esc(x.tag)}">${esc(tagName(x.tag))}<i>${Math.round(x.w * 100)}</i></button>`).join("");
  $$("#taste-tags button").forEach((b) => b.addEventListener("click", () => {
    cycleTag(b.dataset.tag, "inc"); setMode("tags"); setView("picks");
  }));
  $("#taste-games").innerHTML = L.top_games.slice(0, 12).map((g) =>
    `<div class="cell"><img class="thumb" alt="" loading="lazy" src="${headerImg(g.appid)}"><div class="t">${esc(g.name)}<small>${(g.tags || []).slice(0, 3).map(tagName).map(esc).join(", ")}</small></div><span class="v">${num(g.hours)} ${esc(t("h"))}</span><button class="link" data-seed="${g.appid}">${esc(t("more_like"))}</button></div>`).join("");
  $$("[data-seed]", $("#taste-games")).forEach((b) => b.addEventListener("click", () => {
    const g = L.top_games.find((x) => x.appid === Number(b.dataset.seed));
    addSeed({ appid: g.appid, name: g.name, image: headerImg(g.appid) });
    setView("picks");
  }));
}

// ---------------------------------------------------------------- «Скрытые»
async function unhide(appid) { S.hidden = (await api("/api/hidden/remove", { appid })).items; renderHidden(); }
async function unhideAll() { S.hidden = (await api("/api/hidden/remove", { all: true, reason: S.hiddenFilter || null })).items; renderHidden(); }
function renderHidden() {
  $("#hidden-count").textContent = S.hidden.length ? String(S.hidden.length) : "";
  if (S.view !== "hidden") return;
  $$("#hidden-filter button").forEach((b) => b.classList.toggle("on", b.dataset.reason === S.hiddenFilter));
  const items = S.hidden.filter((x) => !S.hiddenFilter || x.reason === S.hiddenFilter);
  const fmt = new Intl.DateTimeFormat(S.lang === "en" ? "en-GB" : S.lang === "uk" ? "uk-UA" : "ru-RU", { day: "numeric", month: "long" });
  $("#hidden-list").innerHTML = items.map((x) => `
    <div class="cell">
      <img class="thumb" alt="" loading="lazy" src="${esc(x.image || headerImg(x.appid))}">
      <div class="t"><a href="https://store.steampowered.com/app/${x.appid}/" target="_blank" rel="noopener">${esc(x.name || `App ${x.appid}`)}</a>
        <small>${esc(t("hf_" + x.reason))}${x.ts ? ", " + esc(fmt.format(new Date(x.ts * 1000))) : ""}</small></div>
      <button class="link" data-unhide="${x.appid}">${esc(t("restore"))}</button>
    </div>`).join("");
  $$("[data-unhide]").forEach((b) => b.addEventListener("click", () => unhide(Number(b.dataset.unhide))));
  $("#hidden-empty").hidden = items.length > 0;
  $("#btn-unhide-all").hidden = items.length === 0;
}

// ---------------------------------------------------------------- настройки и семья
function openSettings() {
  closePop();
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
  renderUpdate();
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
  S.library = null; S.results = []; S.sel = null; S.shown.clear();
  renderGrid(); renderSide();
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
    renderFamilyStatus(); renderTaste();
  } catch (e) { msg.textContent = errText(e); }
  finally { $("#btn-family").disabled = false; }
}
async function clearFamily() {
  S.family = await api("/api/family", { clear: true });
  $("#family-msg").textContent = t("family_cleared");
  renderFamilyStatus(); renderTaste();
}
function renderFamilyStatus() { $("#family-status").textContent = S.family.count ? t("family_status", { n: num(S.family.count) }) : ""; }

async function loadLibrary() {
  if (S.busy) return;
  S.busy = true;
  showError(null);
  renderFindBtn();
  try {
    S.library = await runJob("/api/library", {});
    renderTaste();
  } catch (e) {
    if (!e || e.code !== "cancelled") showError(e);
    if (e && ["bad_key", "not_configured", "profile_not_found"].includes(e.code)) openSettings();
  } finally {
    S.busy = false;
    S.jobId = null;
    renderFindBtn();
    renderStatus(); renderGrid();
  }
}

// ---------------------------------------------------------------- обновления
async function checkUpdate(manual = false) {
  try { S.update = await api(`/api/update${manual ? "?force=1" : ""}`); } catch { return; }
  if (manual && !S.update.available) {
    $("#about-version").textContent = S.update.error === "not_public" ? t("update_private") : t("update_none", { v: S.update.current });
    return;
  }
  renderUpdate();
}
function renderUpdate() {
  const u = S.update;
  $("#ver").textContent = u && u.current ? `v${u.current}` : "";
  if (u && u.current && !$("#settings").open) $("#about-version").textContent = t("version_now", { v: u.current });
  const btn = $("#upd");
  if (!u || !u.available) { btn.hidden = true; return; }
  btn.hidden = false;
  const st = u.download?.status || "idle";
  btn.textContent = st === "downloading" ? t("update_downloading_pct", { v: u.version, p: Math.round((u.download.progress || 0) * 100) })
    : st === "ready" ? `↻ ${t("update_restart")}`
    : st === "error" ? t("update_failed")
    : `↻ ${t("update_available", { v: u.version })}. ${u.can_install ? t("update_install") : t("update_open_page")}`;
  btn.disabled = st === "downloading";
}
async function doUpdate() {
  const u = S.update;
  if (!u) return;
  if (!u.can_install) { window.open(u.page, "_blank", "noopener"); return; }
  if (u.download?.status === "ready") {
    $("#upd").textContent = t("update_restarting");
    try { await api("/api/update/apply", {}); } catch (e) { $("#upd").textContent = errText(e); }
    return;
  }
  try { u.download = await api("/api/update/download", {}); } catch (e) { $("#upd").textContent = errText(e); return; }
  renderUpdate();
  const timer = setInterval(async () => {
    const r = await api("/api/update").catch(() => null);
    if (!r) return;
    S.update = r;
    renderUpdate();
    if (r.download.status !== "downloading") clearInterval(timer);
  }, 700);
}

// ---------------------------------------------------------------- своё окно (без рамки Windows)
const WIN = { frameless: false, rect: null, max: false };
async function initWindow() {
  for (let k = 0; k < 6 && !WIN.frameless; k++) {
    const r = await api("/api/win").catch(() => null);
    if (r && r.frameless) { WIN.frameless = true; setWinRect(r.rect); break; }
    await new Promise((res) => setTimeout(res, 700));
  }
  if (!WIN.frameless) return;
  document.body.classList.add("frameless");
  $("#winbtns").hidden = false;
  $("#edges").hidden = false;
}
function setWinRect(r) {
  if (!r) return;
  WIN.rect = r; WIN.max = !!r.maximized;
  $("#edges").hidden = !WIN.frameless || WIN.max;
  $("#win-max").innerHTML = WIN.max
    ? '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="1.5" y="3.5" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 3.5V3a1.5 1.5 0 0 1 1.5-1.5H9A1.5 1.5 0 0 1 10.5 3v3.5A1.5 1.5 0 0 1 9 8h-.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>'
    : '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="2" y="2" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  $("#win-max").title = t(WIN.max ? "win_restore" : "win_max");
}
async function winAction(action) {
  const r = await api("/api/win", { action }).catch(() => null);
  if (r) setWinRect(r.rect);
}
function bindEdges() {
  $$("#edges i").forEach((el) => el.addEventListener("pointerdown", async (e) => {
    if (!WIN.frameless || WIN.max) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const r = (await api("/api/win").catch(() => null))?.rect || WIN.rect;
    if (!r) return;
    const edge = el.dataset.edge, dpr = window.devicePixelRatio || 1;
    const sx = e.screenX, sy = e.screenY;
    let pending = null, sending = false;
    document.body.classList.add("resizing");
    const send = async () => {
      if (sending || !pending) return;
      sending = true; const p = pending; pending = null;
      await api("/api/win", { action: "rect", ...p }).catch(() => {});
      sending = false; if (pending) send();
    };
    const move = (ev) => {
      const dx = (ev.screenX - sx) * dpr, dy = (ev.screenY - sy) * dpr;
      let { x, y, w, h } = r;
      if (edge.includes("e")) w = r.w + dx;
      if (edge.includes("s")) h = r.h + dy;
      if (edge.includes("w")) { w = r.w - dx; x = r.x + dx; }
      if (edge.includes("n")) { h = r.h - dy; y = r.y + dy; }
      pending = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      send();
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      setTimeout(() => api("/api/win").then((x) => setWinRect(x.rect)).catch(() => {}), 150);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }));
}

// ---------------------------------------------------------------- события
function bind() {
  bindEdges();
  $$("[data-win]").forEach((b) => b.addEventListener("click", () => winAction(b.dataset.win)));
  $("#top").addEventListener("dblclick", (e) => { if (WIN.frameless && (e.target.id === "top" || e.target.id === "drag")) winAction("max"); });
  $("#btn-reset").addEventListener("click", resetFilters);
  $("#tt-close").addEventListener("click", closeTT);
  $("#tt").addEventListener("close", () => { $("#tt-phone").innerHTML = ""; TT.game = null; });
  $("#tt-prev").addEventListener("click", () => showTT(TT.i - 1));
  $("#tt-next").addEventListener("click", () => showTT(TT.i + 1));
  $("#tt").addEventListener("wheel", (e) => {
    if (!TT.ids.length) return;
    const now = Date.now();
    if (now - TT.wheelAt < 450 || Math.abs(e.deltaY) < 20) return;
    TT.wheelAt = now;
    showTT(TT.i + (e.deltaY > 0 ? 1 : -1));
  }, { passive: true });
  $$("#lang button").forEach((b) => b.addEventListener("click", () => { S.lang = b.dataset.lang; store("gp.lang", S.lang); applyI18n(); }));
  $("#btn-theme").addEventListener("click", cycleTheme);
  $$(".nav button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("#btn-settings").addEventListener("click", openSettings);
  $$("#mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $$("[data-pop]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openPop(b.dataset.pop, b); }));
  $$("[data-toggle]").forEach((b) => b.addEventListener("click", () => toggleFlag(b.dataset.toggle)));
  $("#btn-find").addEventListener("click", () => find(false));
  $("#btn-more").addEventListener("click", () => find(true));

  const si = $("#seed-input");
  si.addEventListener("input", () => { clearTimeout(seedTimer); seedTimer = setTimeout(searchSeeds, 260); });
  si.addEventListener("keydown", seedKeys);
  si.addEventListener("blur", () => setTimeout(() => ($("#seed-results").hidden = true), 160));

  $("#s-tiktok").addEventListener("click", () => S.sel && openTikTok(S.sel));

  document.addEventListener("click", (e) => {
    // кнопка внутри окошка могла перерисоваться и выпасть из DOM — это клик внутри, не закрываем
    if (!S.pop || !e.target.isConnected) return;
    if (!e.target.closest("#pop") && !e.target.closest("[data-pop]")) closePop();
  });
  window.addEventListener("resize", closePop);
  $("#grid-scroll").addEventListener("scroll", closePop);
  document.addEventListener("keydown", (e) => {
    if ($("#tt").open) {
      if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); showTT(TT.i + 1); }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); showTT(TT.i - 1); }
      return;
    }
    if ($("#viewer").open) {
      if (e.key === "ArrowLeft") { e.preventDefault(); showViewer(V.i - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); showViewer(V.i + 1); }
      return;
    }
    if (e.key === "Escape" && S.pop) { closePop(); return; }
    if (S.view !== "picks" || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || $("#settings").open) return;
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && S.results.length) {
      e.preventDefault();
      const i = Math.max(0, S.results.indexOf(S.sel));
      const n = Math.max(0, Math.min(S.results.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)));
      select(S.results[n]);
      $(`.card[data-i="${n}"]`)?.scrollIntoView({ block: "nearest" });
    }
  });

  $("#settings-form").addEventListener("submit", (e) => saveSettings(e).catch((err) => { $("#settings-err").textContent = errText(err); $("#settings-err").hidden = false; }));
  $("#settings-cancel").addEventListener("click", () => $("#settings").close());
  $("#btn-family").addEventListener("click", importFamily);
  $("#btn-family-clear").addEventListener("click", clearFamily);
  $("#btn-check-update").addEventListener("click", () => checkUpdate(true));
  $("#upd").addEventListener("click", doUpdate);
  $("#btn-refresh").addEventListener("click", () => { setView("picks"); loadLibrary(); });
  $$("#hidden-filter button").forEach((b) => b.addEventListener("click", () => { S.hiddenFilter = b.dataset.reason; renderHidden(); }));
  $("#btn-unhide-all").addEventListener("click", unhideAll);

  $("#viewer-close").addEventListener("click", closeViewer);
  $("#viewer").addEventListener("close", stopViewer);
  $("#viewer").addEventListener("click", (e) => { if (e.target === $("#viewer")) closeViewer(); });
  $("#viewer-prev").addEventListener("click", () => showViewer(V.i - 1));
  $("#viewer-next").addEventListener("click", () => showViewer(V.i + 1));
}

async function init() {
  bind();
  initWindow();
  setMode(S.mode);
  applyI18n();
  try {
    S.config = await api("/api/config");
    S.family = await api("/api/family").catch(() => S.family);
    S.hidden = (await api("/api/hidden")).items;
    const legacy = load("gp.hidden", []);
    if (legacy.length) { S.hidden = (await api("/api/hidden/import", { appids: legacy })).items; store("gp.hidden", []); }
  } catch (e) { showError(e); return; }
  renderHidden();
  checkUpdate();
  if (!S.config.configured) { openSettings(); return; }
  const r = await api("/api/library").catch(() => ({}));
  if (r.summary) { S.library = r.summary; renderTaste(); }
  else loadLibrary();
}

init();
setInterval(() => fetch("/api/ping").catch(() => {}), 10000);
fetch("/api/ping").catch(() => {});
