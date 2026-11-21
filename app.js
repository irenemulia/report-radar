const TOP_N = 24;
const state = {
  data: null, insights: null, by: {}, search: "", more: {},
  filters: { q: "", country: "", sector: "", min: 0, clean: false, fresh: false, sort: "score" },
};

// ---------- formatting ----------

function money(x, ccy) {
  if (x == null) return "–";
  const s = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(x);
  return (ccy ? ccy + " " : "") + s;
}
function price(x, ccy) {
  if (x == null) return "–";
  return (ccy ? ccy + " " : "") + new Intl.NumberFormat("en", { maximumFractionDigits: x >= 100 ? 0 : 2 }).format(x);
}
function fmtDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
// "Today", "Yesterday" or "12 Nov", relative to the day the data was built
function dayLabel(iso) {
  const days = Math.round((new Date(state.data.date) - new Date(iso)) / 864e5);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
const count = (n) => new Intl.NumberFormat("en").format(n);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const $ = (sel) => document.querySelector(sel);
const link = (t) => "#/c/" + encodeURIComponent(t);
const greens = (c) => c.flags.filter((f) => FLAGS[f] && FLAGS[f].tone === "good");
const reds = (c) => c.flags.filter((f) => FLAGS[f] && FLAGS[f].tone === "bad");

// ---------- watchlist (per browser) ----------

function getWatch() {
  try { return JSON.parse(localStorage.getItem("rr-watch") || "[]"); } catch { return []; }
}
function toggleWatch(t) {
  const w = new Set(getWatch());
  w.has(t) ? w.delete(t) : w.add(t);
  try { localStorage.setItem("rr-watch", JSON.stringify([...w])); } catch {}
  render();
}
function watchButton(t) {
  return `<button class="btn" onclick="toggleWatch('${esc(t)}')">${getWatch().includes(t) ? "★ On your watchlist" : "☆ Add to watchlist"}</button>`;
}
function showMore(key) {
  state.more[key] = true;
  render();
}

// ---------- small components ----------

const ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>`;
const flagIcon = (tone) => `<svg class="flag tone-${tone}" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5v13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3.5 2.5h9l-2.2 3 2.2 3h-9z" fill="currentColor"/></svg>`;

function ring(score, size = 64) {
  const v = verdict(score);
  const r = size / 2 - 5, circ = 2 * Math.PI * r;
  return `<svg class="ring tone-${v.tone}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Score ${score} of 100">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-bg"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fg" stroke-dasharray="${(circ * score) / 100} ${circ}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" dy=".35em" text-anchor="middle" style="font-size:${size / 3.2}px">${score}</text></svg>`;
}

// Red flags first: they are the ones a reader most needs to see
function flagChips(c, limit) {
  const all = [...reds(c), ...greens(c)];
  const shown = limit ? [...reds(c).slice(0, 2), ...greens(c).slice(0, limit - Math.min(2, reds(c).length))] : all;
  const rest = all.length - shown.length;
  return shown.map((f) => `<span class="chip tone-${FLAGS[f].tone}">${FLAGS[f].short}</span>`).join("") + (rest > 0 ? `<span class="chip tone-na">+${rest} more</span>` : "");
}
function tally(c) {
  return `<span class="tally"><span class="tone-good">${flagIcon("good")}${greens(c).length}</span><span class="tone-bad">${flagIcon("bad")}${reds(c).length}</span></span>`;
}

function card(c, rank) {
  const watched = getWatch().includes(c.t);
  const g = greens(c).length, r = reds(c).length;
  return `<a class="card" href="${link(c.t)}">
    <div class="card-head">
      ${ring(c.score, 56)}
      <div class="card-title">
        <strong>${watched ? "★ " : ""}${esc(c.name)}</strong>
        <div class="muted small">${esc(c.country || c.t)} · ${esc(c.industry || c.sector)}</div>
      </div>
      ${rank ? `<span class="rank rank-${rank <= 3 ? rank : "n"}">${rank}</span>` : c.rep ? `<span class="chip tone-new">New report</span>` : ""}
    </div>
    <div class="stats">
      <div class="tone-good"><b>${flagIcon("good")}${g}</b><span>green ${g === 1 ? "flag" : "flags"}</span></div>
      <div class="tone-bad"><b>${flagIcon("bad")}${r}</b><span>red ${r === 1 ? "flag" : "flags"}</span></div>
      <div><b>${c.growth != null ? (c.growth > 0 ? "+" : "") + pct(c.growth, Math.abs(c.growth) < 0.1 ? 1 : 0) : "–"}</b><span>sales a year</span></div>
    </div>
    ${c.flags.length ? `<div class="chips">${flagChips(c, 3)}</div>` : ""}</a>`;
}

// One line in a list of search results. Works for companies we haven't analysed yet too.
function resultRow(c) {
  const where = [c.t, c.country || c.exch, c.industry].filter(Boolean).map(esc).join(" · ");
  return `<a class="result" href="${link(c.t)}">
    ${c.score != null ? ring(c.score, 46) : `<span class="ring-na">?</span>`}
    <div class="result-main"><strong>${esc(c.name)}</strong><div class="muted small">${where}</div></div>
    ${c.score != null ? tally(c) : `<span class="chip tone-na">${c.na ? "No data" : "Analysis pending"}</span>`}</a>`;
}

function feedItem(ev, c) {
  const x = explainEvent(ev, c);
  if (!x) return "";
  return `<a class="feed-item" href="${link(c.t)}"><span class="feed-icon tone-${x.tone}">${x.icon}</span>
    <div><strong>${esc(x.title)}</strong><div class="muted small">${esc(x.text)}</div><div class="when">${dayLabel(ev.d)} · ${esc(c.country || c.t)} · score ${c.score}</div></div></a>`;
}

// A feed section that shows its first few items until "Show all" is pressed
function feed(key, items, limit) {
  const open = state.more[key] || items.length <= limit;
  return `<div class="feed">${items.slice(0, open ? 60 : limit).map(({ ev, c }) => feedItem(ev, c)).join("")}</div>
    ${open ? "" : `<button class="btn more" onclick="showMore('${key}')">Show all ${Math.min(items.length, 60)}</button>`}`;
}

// Bar chart for a series of values (may include negatives). pairs: [[label, value], ...]
function bars(pairs, { fmt = (v) => v, height = 120 } = {}) {
  if (!pairs.length) return `<p class="muted small">No data.</p>`;
  const vals = pairs.map((p) => p[1]);
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const span = max - min || 1;
  const w = 100 / pairs.length;
  const zero = (max / span) * height;
  const items = pairs.map(([y, v], i) => {
    const h = (Math.abs(v) / span) * height;
    const top = v >= 0 ? zero - h : zero;
    return `<g><title>${y}: ${fmt(v)}</title>
      <rect x="${i * w + w * 0.18}%" y="${top}" width="${w * 0.64}%" height="${Math.max(h, 1)}" class="${v < 0 ? "neg" : "pos"}" rx="3"/>
      <text x="${i * w + w / 2}%" y="${height + 16}" text-anchor="middle" class="axis">${y}</text>
      <text x="${i * w + w / 2}%" y="${v >= 0 ? top - 5 : top + h + 12}" text-anchor="middle" class="val">${fmt(v)}</text></g>`;
  });
  return `<svg class="bars" width="100%" height="${height + 24}" style="overflow:visible">${items.join("")}</svg>`;
}

// ---------- pages ----------

function pageToday() {
  const d = state.data, list = d.analysed;
  const banner = (stats) => `
  <section class="banner">
    <div class="eyebrow">${new Date(d.date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div>
    <h1>Company reports, <em>in plain words.</em></h1>
    <p>We read the financial reports of listed companies around the world and point out the green flags and the red flags, so you don't need a finance degree.</p>
    <a class="banner-search" href="#/search">${ICON_SEARCH}<span>Search any company…</span></a>
    ${stats}
  </section>`;
  if (!list.length)
    return banner("") + `<section class="panel"><strong>The first reports are being read right now.</strong>
      <p class="muted">We know of ${count(d.companies.length)} listed companies and analyse them in batches, largest first. Come back in an hour or two.</p></section>`;

  const big = list.filter((c) => c.big);
  const top = big.slice(0, TOP_N);
  const events = (state.insights?.events || []).map((ev) => ({ ev, c: state.by[ev.t] })).filter((x) => x.c && x.c.score != null);
  const bySize = (a, b) => b.ev.d.localeCompare(a.ev.d) || (b.c.mcap || 0) - (a.c.mcap || 0);
  const reports = events.filter((x) => x.ev.kind === "report").sort(bySize);
  const changes = events.filter((x) => x.ev.kind !== "report").sort(bySize);
  const watch = new Set(getWatch());
  const mine = events.filter((x) => watch.has(x.c.t)).sort(bySize);

  // The largest companies due to report in the next week, in date order
  const upcoming = (state.insights?.upcoming || []).map((u) => ({ u, c: state.by[u.t] })).filter((x) => x.c)
    .sort((a, b) => (b.c.mcap || 0) - (a.c.mcap || 0)).slice(0, 12).sort((a, b) => a.u.d.localeCompare(b.u.d));

  const flagged = big.filter((c) => c.mcap >= 10000 && reds(c).length >= 3)
    .sort((a, b) => reds(b).length - reds(a).length || b.mcap - a.mcap).slice(0, 6);
  const lesson = LESSONS[Math.floor(Date.now() / 864e5) % LESSONS.length];
  const countries = new Set(list.map((c) => c.country).filter(Boolean)).size;

  return banner(`<div class="banner-stats">
      <div><b>${count(list.length)}</b><span>companies checked in ${countries} countries</span></div>
      <div><b>${count(list.filter((c) => c.rep).length)}</b><span>published new results in the last 10 days</span></div>
      <div><b>${count(list.filter((c) => c.score >= 75).length)}</b><span>have a "Strong" report card (75+)</span></div>
    </div>`) + `

  ${mine.length ? `<section><h2>News from your watchlist</h2>${feed("mine", mine, 6)}</section>` : ""}

  <section>
    <h2>Fresh reports</h2>
    <p class="muted small">Large companies that just published new results, compared with the same months a year earlier. Tap one for its full report card.</p>
    ${reports.length ? feed("reports", reports, 8) : `<p class="muted">No new results spotted in the last few days. They show up here as soon as a company publishes.</p>`}
  </section>

  ${changes.length ? `<section>
    <h2>Flags that changed</h2>
    <p class="muted small">New numbers raised a flag, or cleared one.</p>
    ${feed("changes", changes, 6)}
  </section>` : ""}

  ${upcoming.length ? `<section>
    <h2>Reports coming up</h2>
    <p class="muted small">Well-known companies expected to publish results in the next few days. Dates come from the companies and can move.</p>
    <table class="cmp dates"><tbody>${upcoming.map(({ u, c }) => `<tr>
      <td>${dayLabel(u.d) === "Today" ? "Today" : fmtDate(u.d).replace(/ \d{4}$/, "")}</td>
      <td><a href="${link(c.t)}">${esc(c.name)}</a> <span class="muted small">${esc(c.country || "")}</span></td>
      <td>${c.score != null ? `${c.score}/100` : ""}</td><td>${c.score != null ? tally(c) : ""}</td></tr>`).join("")}</tbody></table>
  </section>` : ""}

  <section class="panel lesson">
    <div class="eyebrow">Today's 1-minute lesson</div>
    <h3>${esc(lesson.title)}</h3><p>${esc(lesson.text)}</p>
  </section>

  <section>
    <h2>The ${Math.min(TOP_N, top.length)} strongest report cards</h2>
    <p class="muted small">Large companies (worth over US$1 billion) whose reports look healthiest: growing, profitable, backed by real cash, not drowning in debt, and steady. The <a href="#/ranking">ranking</a> has everything. <a href="#/learn">How the score works</a></p>
    <div class="grid">${top.map((c, i) => card(c, i + 1)).join("")}</div>
  </section>

  ${flagged.length ? `<section>
    <h2>Giants with the most red flags</h2>
    <p class="muted small">Being big and famous doesn't make a company healthy. These are worth over US$10 billion and still show several warning signs.</p>
    <div class="results">${flagged.map(resultRow).join("")}</div>
  </section>` : ""}`;
}

function pageRanking() {
  const f = state.filters;
  const all = state.data.analysed;
  const countries = [...new Set(all.map((c) => c.country).filter(Boolean))].sort();
  const sectors = [...new Set(all.map((c) => c.sector))].sort();
  const q = f.q.toLowerCase();
  let list = all.filter((c) =>
    (!q || c.name.toLowerCase().includes(q) || c.t.toLowerCase().includes(q) || (c.industry || "").toLowerCase().includes(q)) &&
    (!f.country || c.country === f.country) && (!f.sector || c.sector === f.sector) &&
    c.score >= f.min && (!f.clean || !reds(c).length) && (!f.fresh || c.rep));
  const key = {
    score: (c) => -c.score, green: (c) => -greens(c).length, red: (c) => -reds(c).length,
    growth: (c) => -(c.growth ?? -9), margin: (c) => -(c.margin ?? -9), size: (c) => -(c.mcap || 0), name: (c) => c.name,
  }[f.sort];
  list = list.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;

  return `
  <section class="hero"><h1>Ranking</h1><p class="muted">Every company we've analysed, healthiest reports first (last update: ${fmtDate(state.data.date)}). Narrow it down by country or sector, or type a word like "bank".</p></section>
  <form class="filters" onsubmit="return false">
    <input id="f-q" type="search" placeholder="Filter by name, ticker, industry…" value="${esc(f.q)}">
    <select id="f-country">${opt("", f.country, "All countries")}${countries.map((x) => opt(x, f.country)).join("")}</select>
    <select id="f-sector">${opt("", f.sector, "All sectors")}${sectors.map((x) => opt(x, f.sector)).join("")}</select>
    <select id="f-sort">${opt("score", f.sort, "Sort: health score")}${opt("green", f.sort, "Sort: most green flags")}${opt("red", f.sort, "Sort: most red flags")}${opt("growth", f.sort, "Sort: fastest growing")}${opt("margin", f.sort, "Sort: most profitable")}${opt("size", f.sort, "Sort: largest")}${opt("name", f.sort, "Sort: name")}</select>
    <label class="range">Min score <b id="f-min-v">${f.min}</b><input id="f-min" type="range" min="0" max="90" step="5" value="${f.min}"></label>
    <label class="check"><input id="f-clean" type="checkbox" ${f.clean ? "checked" : ""}> No red flags</label>
    <label class="check"><input id="f-fresh" type="checkbox" ${f.fresh ? "checked" : ""}> New report only</label>
  </form>
  <p class="muted small">${count(list.length)} companies</p>
  <div class="grid">${list.slice(0, 150).map((c) => card(c)).join("")}</div>
  ${list.length > 150 ? `<p class="muted small">Showing the first 150. Narrow the filters to see more.</p>` : ""}`;
}

// Best matches first: exact ticker, then names starting with the query, then anything containing it.
function searchCompanies(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out = [];
  for (const c of state.data.companies) {
    const n = c.name.toLowerCase(), t = c.t.toLowerCase();
    const rank = t === q || t.split(".")[0] === q ? 0 : n.startsWith(q) ? 1 : t.startsWith(q) ? 2 : n.includes(" " + q) ? 3 : n.includes(q) ? 4 : -1;
    if (rank >= 0) out.push([rank, -(c.mcap || 0), c]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.slice(0, 40).map((x) => x[2]);
}

function searchResultsHtml() {
  const q = state.search.trim();
  if (q.length < 2) {
    const tries = ["Apple", "Toyota", "Nestlé", "Samsung", "Unilever", "Bank Central Asia"];
    return `<p class="muted small">Type at least two letters. Or try one of these:</p>
      <div class="chips">${tries.map((x) => `<button class="btn" data-try="${esc(x)}">${esc(x)}</button>`).join("")}</div>`;
  }
  const found = searchCompanies(q);
  if (!found.length)
    return `<div class="panel"><strong>No company found for "${esc(q)}".</strong>
      <p class="muted">Check the spelling, or try the stock ticker (for example AAPL or BBCA). We cover companies worth more than about US$200 million on the world's main stock markets, so very small companies are not included.</p></div>`;
  return `<p class="muted small">${found.length === 40 ? "Top 40 matches. Keep typing to narrow it down." : found.length + (found.length === 1 ? " match" : " matches")} · Tap a company to see its report card.</p>
    <div class="results">${found.map(resultRow).join("")}</div>`;
}

function pageSearch() {
  return `
  <section class="hero"><h1>Search</h1><p class="muted">Look up any of the ${count(state.data.companies.length)} listed companies we track worldwide and see its report card.</p></section>
  <label class="searchbox">${ICON_SEARCH}<input id="s-q" type="search" placeholder="Company name or ticker, e.g. Toyota or AAPL" value="${esc(state.search)}" autocomplete="off"></label>
  <div id="s-results">${searchResultsHtml()}</div>`;
}

function bindSearch() {
  const input = $("#s-q"), box = $("#s-results");
  const update = () => { state.search = input.value; box.innerHTML = searchResultsHtml(); };
  input.addEventListener("input", update);
  box.addEventListener("click", (e) => {
    const t = e.target.closest("[data-try]");
    if (t) { input.value = t.dataset.try; update(); input.focus(); }
  });
  if (!("ontouchstart" in window)) input.focus();
}

function pagePending(c) {
  return `
  <a href="javascript:history.back()" class="back">← Back</a>
  <section class="company-head">
    <span class="ring-na big">?</span>
    <div>
      <h1>${esc(c.name)}</h1>
      <div class="muted">${[c.t, c.exch].filter(Boolean).map(esc).join(" · ")}</div>
      <div class="verdict tone-ok">${c.na
        ? "<b>No report card available.</b> Yahoo Finance doesn't have usable financial reports for this company, so we can't check it. We'll try again from time to time."
        : "<b>Report card on its way.</b> We read thousands of companies' reports a day, largest first, and this one is still in the queue. It should appear here within a day or two."}</div>
      ${watchButton(c.t)}
    </div>
  </section>`;
}

function flagList(c, codes, tone, empty) {
  return `<div class="flags tone-${tone}">
    <h3>${flagIcon(tone)}${plural(codes.length, tone === "good" ? "green flag" : "red flag")}</h3>
    ${codes.length ? `<ul>${codes.map((f) => `<li><strong>${FLAGS[f].title}</strong><span>${esc(explainFlag(f, c))}</span></li>`).join("")}</ul>` : `<p class="muted small">${empty}</p>`}
  </div>`;
}

// The newest quarterly or half-yearly report, next to the same period a year earlier
function latestReport(c) {
  const q = c.q, fc = c.fccy;
  if (!q) return "";
  const change = (now, before) => (now == null || before == null ? "–" : now < 0 && before > 0 ? "turned to a loss" : now > 0 && before < 0 ? "back in profit" : before <= 0 ? "–" : moved(now / before - 1));
  const tone = (now, before) => (now == null || before == null || (before > 0 && Math.abs(now / before - 1) < 0.005) ? "" : now > before ? "tone-good" : "tone-bad");
  const today = new Date().toISOString().slice(0, 10);
  return `<section>
    <h2>The latest report</h2>
    <p class="muted small">The ${periodName(q.months)} to ${fmtDate(q.end)}, next to the same period a year earlier. ${c.qSeen ? `Published around ${fmtDate(c.qSeen)}.` : ""}
      ${c.next && c.next >= today ? `Next results expected around <b>${fmtDate(c.next)}</b>.` : ""}</p>
    <table class="cmp report"><thead><tr><th></th><th>This time</th><th>A year earlier</th><th>Change</th></tr></thead><tbody>
      <tr><td>Sales</td><td>${money(q.rev, fc)}</td><td>${money(q.rev0, fc)}</td><td class="${tone(q.rev, q.rev0)}">${change(q.rev, q.rev0)}</td></tr>
      <tr><td>Profit</td><td>${q.net != null && q.net < 0 ? `Loss of ${money(-q.net, fc)}` : money(q.net, fc)}</td><td>${q.net0 != null && q.net0 < 0 ? `Loss of ${money(-q.net0, fc)}` : money(q.net0, fc)}</td><td class="${tone(q.net, q.net0)}">${change(q.net, q.net0)}</td></tr>
    </tbody></table>
  </section>`;
}

// Where each 100 of sales went in the latest year
function splitBar(c) {
  const s = c.split;
  if (!s) return "";
  const rows = [
    ["make", "Making what it sells", "materials, factories, delivery"],
    ["run", "Running the company", "staff, offices, advertising, research"],
    ["other", "Interest, tax and other", "lenders and the tax office"],
    ["profit", "Profit", "what's left for the owners"],
  ].map(([k, label, hint]) => ({ k, label, hint, v: s[k] }));
  const total = rows.reduce((sum, r) => sum + Math.max(r.v, 0), 0) || 1;
  const words = (r) => r.k === "profit" && r.v < 0 ? `<b>Loss</b> of ${per100(-r.v, 1)} <span class="muted">it spent more than it sold</span>`
    : r.k === "other" && r.v < 0 ? `<b>Other income</b> added ${per100(-r.v, 1)} <span class="muted">gains outside the main business</span>`
    : `<b>${r.label}</b> ${per100(r.v, 1)} <span class="muted">${r.hint}</span>`;
  return `<section class="panel">
    <h3>Where each 100 of sales went</h3>
    <p class="muted small">Imagine everything the company sold in ${c.hist.revenue[c.hist.revenue.length - 1][0]} as 100 coins. This is where they ended up.</p>
    <div class="split">${rows.filter((r) => r.v > 0).map((r) => `<span class="seg-${r.k}" style="width:${(r.v / total) * 100}%" title="${r.label}: ${per100(r.v, 1)}"></span>`).join("")}</div>
    <ul class="split-legend">${rows.map((r) => `<li><i class="seg-${r.k}${r.v < 0 ? " neg" : ""}"></i><span>${words(r)}</span></li>`).join("")}</ul>
  </section>`;
}

function pageCompany(c) {
  const v = verdict(c.score);
  const fc = c.fccy;
  const g = greens(c), r = reds(c);
  const quarters = (c.qhist || []).map(([end, rev]) => [new Date(end + "T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "2-digit" }), rev]);
  const tag = explainPrice(c);

  return `
  <a href="javascript:history.back()" class="back">← Back</a>
  <section class="company-head">
    ${ring(c.score, 96)}
    <div>
      <h1>${esc(c.name)}</h1>
      <div class="muted">${[c.t, c.country, c.industry || c.sector].filter(Boolean).map(esc).join(" · ")}</div>
      <div class="verdict tone-${v.tone}"><b>${v.label}.</b> ${v.text}</div>
      <p class="plain">${esc(plainSummary(c))}</p>
      ${watchButton(c.t)}
      <span class="muted small checked">Last checked ${fmtDate(c.updated)}</span>
    </div>
  </section>

  <section>
    <h2>Green flags and red flags</h2>
    <div class="flag-cols">
      ${flagList(c, g, "good", "None of the good signs we look for showed up in its reports.")}
      ${flagList(c, r, "bad", "None of the warning signs we look for showed up in its reports.")}
    </div>
  </section>

  ${latestReport(c)}

  <section>
    <h2>The report card, explained</h2>
    <div class="parts">${PARTS.map((p) => {
      const e = explainPart(p.key, c);
      const got = c.parts[p.key];
      return `<div class="part tone-${e.tone}">
        <div class="part-head"><span class="dot tone-${e.tone}"></span><strong>${p.title}</strong><span class="muted small">${got == null ? "not scored" : `${got}/${p.max}`}</span></div>
        <div class="meter"><span class="tone-${e.tone}" style="width:${got == null ? 0 : (got / p.max) * 100}%"></span></div>
        <div class="muted small q">${p.question}</div>
        <p>${esc(e.text)}</p></div>`;
    }).join("")}</div>
  </section>

  ${splitBar(c)}

  <section class="charts">
    <div class="panel"><h3>Sales, year by year</h3><p class="muted small">In ${esc(fc)}. Is the business growing?</p>${bars(c.hist.revenue, { fmt: (x) => money(x) })}</div>
    <div class="panel"><h3>Profit, year by year</h3><p class="muted small">In ${esc(fc)}. Bars below zero are losses.</p>${bars(c.hist.net, { fmt: (x) => money(x) })}</div>
    <div class="panel"><h3>Spare cash, year by year</h3><p class="muted small">In ${esc(fc)}. Cash left after bills and investments ("free cash flow").</p>${bars(c.hist.fcf, { fmt: (x) => money(x) })}</div>
    <div class="panel"><h3>Sales in the latest reports</h3><p class="muted small">In ${esc(fc)}. Each bar is one ${c.q && c.q.months === 6 ? "half-year" : "quarter (three months)"}.</p>${bars(quarters, { fmt: (x) => money(x) })}</div>
  </section>

  <section>
    <h2>The price tag</h2>
    <p class="muted small">The score above is about how healthy the business is. Whether its shares are cheap or expensive is a separate question.</p>
    <div class="keyfacts">
      <div><span class="muted small">Share price</span><b>${price(c.price, c.ccy)}</b></div>
      <div><span class="muted small">Whole company is worth</span><b>${money(c.mcap, c.ccy)}</b></div>
      <div><span class="muted small">Price ÷ yearly profit (P/E)</span><b>${c.m.pe ? c.m.pe.toFixed(1) : "–"}</b></div>
      <div><span class="muted small">Dividend per year</span><b>${c.m.yield ? pct(c.m.yield) : "None"}</b></div>
    </div>
    <div class="verdict tone-na">${esc(tag)}</div>
  </section>

  ${c.summary ? `<section class="panel"><h3>What does this company do?</h3><p>${esc(c.summary)}</p>${c.web ? `<a href="${esc(c.web)}" target="_blank" rel="noopener">Company website and full reports ↗</a>` : ""}</section>` : ""}`;
}

// A company's full analysis lives in its own file and is loaded when its page is opened.
const details = {};
function loadDetail(t) {
  if (!details[t]) {
    details[t] = fetch(`data/c/${encodeURIComponent(t)}.json`, { cache: "no-cache" })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((c) => { details[t].ready = true; return c; });
    details[t].catch(() => { delete details[t]; });
  }
  return details[t];
}

async function showCompany(t) {
  const app = $("#app");
  const row = state.by[t];
  if (!row) { app.innerHTML = `<p>Company not found. <a href="#/search">Search for another one</a></p>`; return; }
  if (row.score == null) { app.innerHTML = pagePending(row); return; }
  if (!(details[t] && details[t].ready)) app.innerHTML = `<p class="muted">Loading ${esc(row.name)}…</p>`;
  try {
    const c = await loadDetail(t);
    if (currentRoute().arg !== t) return;  // the visitor moved on while it loaded
    app.innerHTML = pageCompany(c);
  } catch (e) {
    if (currentRoute().arg === t) app.innerHTML = `<p>Couldn't load this company's data. Check your connection and <a href="javascript:location.reload()">try again</a>.</p>`;
  }
}

function pageWatch() {
  const list = getWatch().map((t) => state.by[t]).filter(Boolean);
  const done = list.filter((c) => c.score != null), waiting = list.filter((c) => c.score == null);
  return `<section class="hero"><h1>Your watchlist</h1><p class="muted">Companies you've starred. News about them appears at the top of the Today page. The list is saved in this browser only.</p></section>
  ${list.length ? "" : `<p class="muted">Nothing here yet. Open any company and tap "Add to watchlist".</p>`}
  ${done.length ? `<div class="grid">${done.map((c) => card(c)).join("")}</div>` : ""}
  ${waiting.length ? `<div class="results">${waiting.map(resultRow).join("")}</div>` : ""}`;
}

function pageLearn() {
  const d = state.data;
  const flagItems = (tone) => Object.values(FLAGS).filter((f) => f.tone === tone).map((f) => `<li><strong>${f.title}</strong><span>${f.about}</span></li>`).join("");
  return `<section class="hero"><h1>Learn</h1><p class="muted">Everything on this site, explained simply.</p></section>
  <section class="panel"><h2>How the health score works</h2>
    <p>Each company gets a score out of 100 from five checks on its financial reports, each worth 20 points. None of them needs an opinion: they are simple questions you could ask about any business, even a corner shop.</p>
    <ol class="score-list">${PARTS.map((p) => `<li><b>${p.title}</b>: ${p.question}</li>`).join("")}</ol>
    <p class="muted small">Banks, insurers and property companies are scored on growth, profitability and steadiness only, because borrowing and moving cash is their business. A company that lost money in its latest year can't score above 45. The share price plays no part in the score.</p>
  </section>
  <section><h2>The flags we look for</h2>
    <p class="muted small">A flag is one specific thing in a company's reports that is clearly good or clearly worrying. One red flag isn't a verdict. Several together deserve a closer look.</p>
    <div class="flag-cols">
      <div class="flags tone-good"><h3>${flagIcon("good")}Green flags</h3><ul>${flagItems("good")}</ul></div>
      <div class="flags tone-bad"><h3>${flagIcon("bad")}Red flags</h3><ul>${flagItems("bad")}</ul></div>
    </div>
  </section>
  <section class="panel"><h2>Which companies are covered</h2>
    <p>We track ${count(d.companies.length)} listed companies: those worth more than about US$200 million on the world's main stock markets. So far ${count(d.analysed.length)} of them have a report card.</p>
    <p class="muted small">Companies publish new numbers every three or six months. We re-read a company right after its results date, and otherwise about once a week.</p>
  </section>
  <section><h2>Lessons</h2><div class="lessons">${LESSONS.map((l) => `<div class="panel"><h3>${esc(l.title)}</h3><p>${esc(l.text)}</p></div>`).join("")}</div></section>
  <section class="panel"><h2>Glossary</h2><dl class="glossary">${GLOSSARY.map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join("")}</dl></section>
  <section class="panel"><h2>Before you invest</h2>
    <p>This site is a <b>starting point for research, not advice</b>. The numbers come from Yahoo Finance and can be late or wrong, and a report card only describes the past. Before buying, read the company's own latest report and the news about it, and don't put all your money in one company or one industry.</p></section>`;
}

// ---------- router ----------

function currentRoute() {
  const [, page, arg] = (location.hash.slice(1) || "/").split("/");
  return { page: page || "", arg: decodeURIComponent(arg || "") };
}

function render() {
  const { page, arg } = currentRoute();
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#/" + page));
  const app = $("#app");
  if (!state.data) return;
  if (page === "c") { showCompany(arg); return; }
  if (page === "search" && arg) state.search = arg;  // #/search/bank opens with "bank" filled in
  app.innerHTML =
    page === "ranking" ? pageRanking() :
    page === "search" ? pageSearch() :
    page === "watch" ? pageWatch() :
    page === "learn" ? pageLearn() : pageToday();
  if (page === "ranking") bindFilters();
  if (page === "search") bindSearch();
}

function bindFilters() {
  const f = state.filters;
  const rerender = (focusId) => {
    const el = document.getElementById(focusId);
    const pos = el && el.selectionStart;
    render();
    const again = document.getElementById(focusId);
    if (again) { again.focus(); if (pos != null && again.setSelectionRange) again.setSelectionRange(pos, pos); }
  };
  $("#f-q").addEventListener("input", (e) => { f.q = e.target.value; rerender("f-q"); });
  $("#f-country").addEventListener("change", (e) => { f.country = e.target.value; render(); });
  $("#f-sector").addEventListener("change", (e) => { f.sector = e.target.value; render(); });
  $("#f-sort").addEventListener("change", (e) => { f.sort = e.target.value; render(); });
  $("#f-min").addEventListener("input", (e) => { $("#f-min-v").textContent = e.target.value; });
  $("#f-min").addEventListener("change", (e) => { f.min = +e.target.value; render(); });
  $("#f-clean").addEventListener("change", (e) => { f.clean = e.target.checked; render(); });
  $("#f-fresh").addEventListener("change", (e) => { f.fresh = e.target.checked; render(); });
}

window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

(async function init() {
  try {
    const [idx, ins] = await Promise.all([
      fetch("data/index.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/insights.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null),
    ]);
    // index.json stores each company as a compact row; turn the rows into objects
    const k = Object.fromEntries(idx.cols.map((name, i) => [name, i]));
    const companies = idx.rows.map((r) => ({
      t: r[k.t], name: r[k.name] || r[k.t], country: r[k.country], sector: r[k.sector] || "Other", industry: r[k.industry],
      score: r[k.score], flags: (r[k.flags] || []).map((i) => idx.flagCodes[i]), growth: r[k.growth], margin: r[k.margin],
      mcap: r[k.mcap], big: !!r[k.big], exch: r[k.exch], na: !!r[k.na], rep: r[k.rep],
    }));
    state.data = { date: idx.date, companies, analysed: companies.filter((c) => c.score != null) };
    state.insights = ins;
    companies.forEach((c) => (state.by[c.t] = c));
    render();
  } catch (e) {
    $("#app").innerHTML = `<p>The data isn't ready yet. An update may still be running, so try again in a few minutes.</p>`;
  }
})();
