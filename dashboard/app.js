// Token Radar v2 dashboard. Vanilla JS, no network. Reads window.RADAR (data.js).
(function () {
  var R = window.RADAR;
  var asOf = R.asOf;
  var $ = function (id) { return document.getElementById(id); };
  // Row: [slug, name, cat, tvl, chg, listed, implied, planKey, chainIdx, watch]
  // Live: [slug, name, cat, tvl, mcap]
  var GAS = { Solana: "~$0.01", Base: "~$0.01–0.05", Sui: "~$0.01–0.05", Aptos: "~$0.01–0.05", Polygon: "~$0.01–0.05", "Hyperliquid L1": "~$0.01–0.05", Monad: "~$0.01–0.05", Arbitrum: "~$0.10–0.50", Optimism: "~$0.05–0.20", Binance: "~$0.05–0.20", Avalanche: "~$0.10–0.50", Linea: "~$0.05–0.20", Scroll: "~$0.05–0.20", Unichain: "~$0.01–0.05", Blast: "~$0.05–0.20", Sonic: "~$0.01–0.05", Berachain: "~$0.05–0.20", Ethereum: "~$2–10" };
  var DGAS = "~$0.10–1.00";
  function money(n) { return "$" + Math.round(n).toLocaleString("en-US"); }
  function short(n) { if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B"; if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M"; if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K"; return money(n); }
  function pct(x) { return x === null || x === undefined ? "—" : (x > 0 ? "+" : "") + x.toFixed(1) + "%"; }
  function daysSince(d) { if (!d) return null; return Math.max(0, Math.floor((Date.parse(asOf + "T00:00:00Z") - Date.parse(d + "T00:00:00Z")) / 864e5)); }
  function growthF(chg) { if (chg === null || chg === undefined) return 1; return Math.min(1.2, Math.max(0.8, 1 + chg / 100)); }
  function ageF(listed) { var d = daysSince(listed); if (d === null) return 1; var y = d / 365.25; return Math.min(1, Math.max(0.85, 1 - 0.15 * Math.min(1, Math.log10(1 + y) / Math.log10(6)))); }
  function fitFor(cat) { return (cat && R.model.fits[cat]) || R.model.fits["*"]; }
  function curveVal(cat, tvl) { var f = fitFor(cat); return Math.pow(10, f.a + f.b * Math.log10(tvl)); }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function chainName(row) { return R.chains[row[8]] || ""; }
  function gasFor(row) { return GAS[chainName(row)] || DGAS; }
  function subSteps(row) { var p = R.plans[row[7]]; var ch = chainName(row), g = gasFor(row); return p.steps.map(function (s) { return s.split("{CHAIN}").join(ch).split("{GAS}").join(g); }); }
  function verdict(row) {
    var tvlM = row[3] / 1e6, chg = row[4], ch = chainName(row);
    var size = tvlM >= 500 ? "very large TVL" : tvlM >= 100 ? "large TVL" : tvlM >= 25 ? "mid-size TVL" : "small TVL";
    var g = chg === null ? "no 7-day change reported" : chg >= 10 ? "fast 7-day growth (+" + chg.toFixed(1) + "%)" : chg <= -10 ? "sharp 7-day fall (" + chg.toFixed(1) + "%)" : "steady 7-day change (" + chg.toFixed(1) + "%)";
    var cheap = !GAS[ch] || GAS[ch].indexOf("$2") !== 0;
    var v = tvlM >= 100 && (chg || 0) >= 0 ? "Worth farming" : tvlM >= 25 ? "Worth a small farm" : "Farm only with small size";
    return v + ": " + size + " ($" + Math.round(tvlM) + "M), " + g + ", cheapest chain " + ch + " (" + (cheap ? "cheap gas" : "higher gas") + "), implied value " + money(row[6]) + ".";
  }

  // ---- header stats
  $("stats").innerHTML = [["Board rows", R.nBoard], ["Watchlist", R.nWatch + " covered"], ["Live comps", R.nComps], ["Snapshot", asOf]].map(function (s) {
    return '<div class="stat"><b>' + esc(s[1]) + '</b><span>' + esc(s[0]) + '</span></div>';
  }).join("");
  $("asOf").textContent = asOf;

  // ---- model panel: validation + fits
  var L = R.model.loo, S = R.model.split;
  $("validation").innerHTML =
    '<div><span class="vnum">' + (L.medErr * 100).toFixed(0) + '%</span> <span class="vlab">median abs. error, leave-one-out over ' + L.n + ' comps; ' + Math.round(L.in2x * 100) + '% of predictions within 2&times; of the true mcap</span></div>' +
    '<div style="margin-top:10px"><span class="vnum">' + (S.medErr * 100).toFixed(0) + '%</span> <span class="vlab">median abs. error, time-split: fitted on ' + S.nTrain + ' comps listed before ' + esc(S.cutoff) + ', tested on ' + S.nTest + ' listed after; ' + Math.round(S.in2x * 100) + '% within 2&times;</span></div>' +
    '<p class="note" style="margin-top:10px">Errors near 2&times; are typical here — the model is honest about that. Its edge is the fitted curve and the reported validation, not a small error.</p>';
  var cats = Object.keys(R.model.fits).filter(function (k) { return k !== "*"; }).sort();
  $("fitsTable").querySelector("tbody").innerHTML = cats.map(function (c) {
    var f = R.model.fits[c];
    return "<tr><td>" + esc(c) + "</td><td>" + f.b.toFixed(3) + "</td><td>" + f.a.toFixed(3) + "</td><td>" + f.n + "</td><td>" + (R.model.ratios[c] !== undefined ? R.model.ratios[c].toFixed(3) : "—") + "</td><td>category</td></tr>";
  }).join("") + '<tr><td>All comps (global fallback)</td><td>' + R.model.fits["*"].b.toFixed(3) + '</td><td>' + R.model.fits["*"].a.toFixed(3) + '</td><td>' + R.model.fits["*"].n + '</td><td>—</td><td>global</td></tr>';

  // ---- filters
  var state = { q: "", cat: "", chain: "", status: "pre", sort: "implied", dir: -1 };
  var catCounts = {};
  R.rows.forEach(function (r) { catCounts[r[2]] = (catCounts[r[2]] || 0) + 1; });
  var catNames = Object.keys(catCounts).sort();
  $("catPills").innerHTML = '<button class="pill on" data-cat="">All <span class="n">' + R.rows.length + '</span></button>' + catNames.map(function (c) {
    return '<button class="pill" data-cat="' + esc(c) + '">' + esc(c) + ' <span class="n">' + catCounts[c] + '</span></button>';
  }).join("");
  var chainNames = [];
  R.rows.forEach(function (r) { var c = chainName(r); if (chainNames.indexOf(c) < 0) chainNames.push(c); });
  chainNames.sort();
  $("chainFilter").innerHTML = '<option value="">All chains</option>' + chainNames.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join("");

  function filtered() {
    var q = state.q.toLowerCase();
    return R.rows.filter(function (r) {
      if (state.cat && r[2] !== state.cat) return false;
      if (state.chain && chainName(r) !== state.chain) return false;
      if (q && (r[1] + " " + r[0]).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function sortRows(list) {
    var k = state.sort, d = state.dir;
    var idx = { rank: -1, name: 1, cat: 2, tvl: 3, chg: 4, age: 5, implied: 6 }[k];
    return list.slice().sort(function (a, b) {
      var va, vb;
      if (k === "rank") { va = R.rows.indexOf(a); vb = R.rows.indexOf(b); }
      else if (k === "age") { va = daysSince(a[5]); vb = daysSince(b[5]); va = va === null ? -1 : va; vb = vb === null ? -1 : vb; }
      else if (k === "chg") { va = a[4] === null ? -1e9 : a[4]; vb = b[4] === null ? -1e9 : b[4]; }
      else { va = a[idx]; vb = b[idx]; }
      if (va < vb) return -1 * d; if (va > vb) return 1 * d; return a[0] < b[0] ? -1 : 1;
    });
  }
  function renderBoard() {
    var list = sortRows(filtered());
    $("countLine").textContent = "Showing " + list.length + " of " + R.rows.length + " pre-token protocols" + (state.cat ? " in " + state.cat : "") + (state.chain ? " on " + state.chain : "") + ". Ranked by fitted implied value.";
    $("board").querySelector("tbody").innerHTML = list.map(function (r) {
      var rank = R.rows.indexOf(r) + 1, d = daysSince(r[5]);
      var chgCls = r[4] === null ? "" : r[4] >= 0 ? "pos" : "neg";
      return '<tr data-slug="' + esc(r[0]) + '"><td>' + rank + '</td><td><b>' + esc(r[1]) + '</b>' + (r[9] ? ' <span class="tag">watchlist</span>' : "") + '<br><span style="color:var(--mut);font-size:12px">' + esc(r[0]) + ' · ' + esc(chainName(r)) + '</span></td><td>' + esc(r[2]) + '</td><td class="num">' + short(r[3]) + '</td><td class="num ' + chgCls + '">' + pct(r[4]) + '</td><td class="num">' + (d === null ? "—" : d.toLocaleString("en-US")) + '</td><td class="num"><b>' + short(r[6]) + '</b></td><td>' + esc(R.plans[r[7]].title) + '</td></tr>';
    }).join("");
    document.querySelectorAll("#board tbody tr").forEach(function (tr) {
      tr.addEventListener("click", function () { openDetail(tr.getAttribute("data-slug")); });
    });
    document.querySelectorAll("#board th[data-k]").forEach(function (th) {
      th.classList.toggle("sorted", th.getAttribute("data-k") === state.sort);
    });
  }

  // ---- live comps table
  $("liveCount").textContent = R.live.length;
  $("liveTable").querySelector("tbody").innerHTML = R.live.map(function (r) {
    return "<tr><td><b>" + esc(r[1]) + "</b><br><span style=\"color:var(--mut);font-size:12px\">" + esc(r[0]) + "</span></td><td>" + esc(r[2]) + "</td><td class=\"num\">" + short(r[3]) + "</td><td class=\"num\">" + short(r[4]) + "</td><td class=\"num\">" + (r[4] / r[3]).toFixed(3) + "</td></tr>";
  }).join("");

  // ---- detail view
  function openDetail(slug) {
    var r = null;
    R.rows.forEach(function (x) { if (x[0] === slug) r = x; });
    if (!r) return;
    var rank = R.rows.indexOf(r) + 1;
    var f = fitFor(r[2]), cv = curveVal(r[2], r[3]), gf = growthF(r[4]), af = ageF(r[5]);
    var cap = Math.min(10 * r[3], 1e14);
    var d = daysSince(r[5]);
    var steps = subSteps(r);
    $("detail").hidden = false;
    $("detail").innerHTML =
      '<h2>' + esc(r[1]) + ' <span style="color:var(--mut);font-size:14px">#' + rank + ' · ' + esc(r[2]) + ' · ' + esc(chainName(r)) + '</span></h2>' +
      '<p class="meta">' + esc(r[0]) + ' · TVL ' + money(r[3]) + ' · 7-day ' + pct(r[4]) + ' · ' + (d === null ? "listed date not reported" : d.toLocaleString("en-US") + " days since first tracked (" + esc(r[5]) + ")") + ' · records no token.</p>' +
      '<div class="kv"><div class="big"><b>' + money(r[6]) + '</b><span>Implied value</span></div>' +
      '<div><b>' + money(cv) + '</b><span>Size-curve value (' + (f.m === "cat" ? "category fit" : "global fit") + ')</span></div>' +
      '<div><b>&times;' + gf.toFixed(2) + '</b><span>Growth factor</span></div>' +
      '<div><b>&times;' + af.toFixed(2) + '</b><span>Age factor</span></div>' +
      '<div><b>' + short(cap) + '</b><span>Cap (10&times; TVL)</span></div></div>' +
      '<p class="note">Breakdown: curve ' + money(cv) + ' &times; growth ' + gf.toFixed(2) + ' &times; age ' + af.toFixed(2) + ' = ' + money(cv * gf * af) + (r[6] >= cap ? ', capped at ' + money(cap) : '') + '. Fit: slope ' + f.b.toFixed(3) + ', intercept ' + f.a.toFixed(3) + ', ' + f.n + ' comps, median MC/TVL ' + (R.model.ratios[r[2]] !== undefined ? R.model.ratios[r[2]].toFixed(3) : "—") + '.</p>' +
      '<h3>' + esc(R.plans[r[7]].title) + ' — farm plan</h3><ol class="steps">' + steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + '</ol>' +
      '<div class="verdict">' + esc(verdict(r)) + '</div>' +
      '<p class="hint">Costs are typical gas on ' + esc(chainName(r)) + ' per transaction plus any protocol fee; time is spread over 4–8 weeks. Nothing here predicts a token launch.</p>';
    // Only scroll when the panel opened above the visible area (e.g. after
    // clicking a row far down the board). Never scroll on a fresh #detail=
    // load: the panel already sits inside the first viewport, and a programmatic
    // scroll before a screenshot leaves the top of the page unpainted.
    var rect = $("detail").getBoundingClientRect();
    if (rect.top < 0) $("detail").scrollIntoView({ behavior: "auto", block: "start" });
    if (history.replaceState) history.replaceState(null, "", "#detail=" + slug);
  }

  // ---- events
  $("search").addEventListener("input", function (e) { state.q = e.target.value; renderBoard(); });
  $("chainFilter").addEventListener("change", function (e) { state.chain = e.target.value; renderBoard(); });
  $("catPills").addEventListener("click", function (e) {
    var b = e.target.closest("[data-cat]"); if (!b) return;
    state.cat = b.getAttribute("data-cat");
    document.querySelectorAll("#catPills .pill").forEach(function (p) { p.classList.toggle("on", p === b); });
    renderBoard();
    if (history.replaceState) history.replaceState(null, "", state.cat ? "#cat=" + encodeURIComponent(state.cat) : "#");
  });
  document.querySelectorAll(".status .pill").forEach(function (b) {
    b.addEventListener("click", function () {
      state.status = b.getAttribute("data-status");
      document.querySelectorAll(".status .pill").forEach(function (p) { p.classList.toggle("on", p === b); });
      $("boardWrap").hidden = state.status !== "pre";
      $("liveWrap").hidden = state.status !== "live";
    });
  });
  document.querySelectorAll("#board th[data-k]").forEach(function (th) {
    th.addEventListener("click", function () {
      var k = th.getAttribute("data-k");
      if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = k === "name" || k === "cat" ? 1 : -1; }
      renderBoard();
    });
  });

  // ---- deep links for screenshots / sharing: #detail=<slug>, #cat=<category>
  renderBoard();
  var h = location.hash || "";
  var m = h.match(/detail=([^&]+)/);
  if (m) { openDetail(decodeURIComponent(m[1])); return; }
  var c = h.match(/cat=([^&]+)/);
  if (c) {
    var cat = decodeURIComponent(c[1]);
    state.cat = cat;
    document.querySelectorAll("#catPills .pill").forEach(function (p) { p.classList.toggle("on", p.getAttribute("data-cat") === cat); });
    renderBoard();
  }
})();
