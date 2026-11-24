// App: loads the account, runs the backtests, picks strategies, then trades live on 1-minute candles.
(function (SL) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ui = SL.ui, F = ui.fmt;
  const POLL_MS = 20000;
  const MAX_CATCHUP = 6.5 * 86400;
  window.addEventListener('error', (e) => console.error('[scalp-lab]', (e.error && e.error.stack) || e.message));

  const app = (SL.app = {
    st: null, eng: null, hist5m: {}, m1: {}, feed: {}, bt: null,
    view: { sym: 'EURUSD', tf: '5m', page: 'trades' }, filters: { sym: '', strat: '', res: '' },
    busy: false, catchingUp: false, notify: false, chartKey: '',
  });

  const banner = (html, warn) => {
    const b = $('banner');
    if (!html) { b.hidden = true; return; }
    b.hidden = false; b.className = 'banner' + (warn ? ' warn' : ''); b.innerHTML = html;
  };
  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } } };

  // ---------- persistence ----------
  async function loadState() { try { return await (await fetch('/api/state')).json(); } catch (e) { return null; } }
  async function saveNow() { try { await fetch('/api/state', { method: 'POST', body: JSON.stringify(app.st) }); } catch (e) { console.warn('save failed', e); } }
  let saveT = null;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(saveNow, 800); };

  // ---------- strategy selection ----------
  const active = (sym) => SL.activeFor(app.st, app.bt, sym); // this chart's strategies + tuned settings
  const isEnabled = (sym, id) => SL.isActive(app.st, app.bt, sym, id);
  const activeText = () => SL.SYMBOLS.flatMap((s) => active(s).map((a) => `${F.strat(a.strat)}${a.label ? ' (' + a.label + ')' : ''} on ${F.label(s)}`));

  const runBacktests = () => SL.runBacktests(app.hist5m, { news: app.st.news, settings: { maxHoldMin: app.st.settings.maxHoldMin, newsFilter: app.st.settings.newsFilter } });

  // This week's high-impact news (kept in the account so later backtests can use it too)
  async function loadNews() {
    try {
      const r = await fetch('/api/news', { cache: 'no-store' });
      if (!r.ok) return;
      app.st.news = SL.mergeNews(app.st.news, SL.parseNews(await r.json()), SL.nowSec());
      app.st.newsAt = SL.nowSec();
    } catch (e) { console.warn('news', e); }
  }
  function newsLine() {
    if (app.st.settings.newsFilter === false) return ' News filter is off.';
    const now = SL.nowSec(), cur = SL.SYMBOLS.map((s) => SL.newsBlock(app.st.news, s, now)).find(Boolean);
    if (cur) return ` <b>News filter active:</b> no new trades around ${F.esc(cur.c + ' ' + cur.title)} (${F.tLocal(cur.t)}).`;
    const next = (app.st.news || []).find((e) => e.t > now);
    return next ? ` Next big news: <b>${F.esc(next.c + ' ' + next.title)}</b> ${new Date(next.t * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} — no new trades from 30 min before to 15 min after.`
      : ' News filter on (no big US/euro news found for the rest of this week).';
  }

  const applySelection = () => SL.applySelection(app.st, app.bt);
  function runPortfolio() { if (app.bt) app.bt.portfolio = { stats: SL.runPortfolio(app.st, app.hist5m, app.bt).stats }; }

  // The full test takes several seconds, so its results are reused for 6 hours (like the cloud runner)
  const btKey = () => JSON.stringify([SL.STRATEGIES.map((s) => s.id + ':' + (s.variants ? s.variants.length : 1)), app.st.settings.maxHoldMin, app.st.settings.newsFilter]);
  function runTests(force) {
    const c = app.st.btCache;
    if (!force && c && c.bt && c.key === btKey() && SL.nowSec() - c.at < 6 * 3600) app.bt = c.bt;
    else {
      const nb = runBacktests();
      if (nb) { app.bt = nb; app.st.btCache = { at: SL.nowSec(), key: btKey(), bt: nb }; }
    }
    applySelection(); runPortfolio();
  }

  async function loadHistory() {
    for (const sym of SL.SYMBOLS) {
      try { app.hist5m[sym] = (await SL.fetchBars(sym, { interval: '5m', range: '60d' })).bars; }
      catch (e) { app.feed[sym] = { state: 'error', err: e.message }; console.warn(sym, e); }
    }
  }

  async function refreshBacktest() {
    await loadHistory();
    runTests(true); save(); renderAll();
  }

  // ---------- live data ----------
  const agg5 = SL.agg5;

  function mergeM1(sym, bars) {
    const m = new Map((app.m1[sym] || []).map((b) => [b.t, b]));
    for (const b of bars) m.set(b.t, b);
    app.m1[sym] = [...m.values()].sort((a, b) => a.t - b.t).slice(-2000);
  }

  function updateFeed(sym, now) {
    const m = app.m1[sym], last = m && m[m.length - 1];
    if (!last) { app.feed[sym] = { state: 'closed' }; return; }
    const age = now - last.t;
    app.feed[sym] = { state: age < 240 ? 'live' : age < 1500 ? 'delayed' : 'closed', price: last.c, lastBar: last.t };
  }

  // 1-min bars that are finished: a newer bar exists, or nothing new came for 15 minutes
  function completeNew(sym, bars, now) {
    const lastT = app.st.lastT[sym] || 0, out = [];
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].t <= lastT) continue;
      if (i < bars.length - 1 || now - bars[i].t > 900) out.push({ sym, bar: bars[i] });
    }
    return out;
  }

  function onEvent(e) {
    if (e.type === 'close') scheduleReports();
    if (!app.catchingUp) notify(e);
    save();
  }

  async function startLive() {
    const st = app.st, now = SL.nowSec();
    app.eng = new SL.Engine({ state: st, baseSec: 60, active, onEvent, live: true });
    app.catchingUp = true;
    let pending = [];
    for (const sym of SL.SYMBOLS) {
      const H = app.hist5m[sym] || [];
      let lastT = st.lastT[sym];
      if (lastT && now - lastT > MAX_CATCHUP) {
        const lb = H.filter((b) => b.t <= lastT).pop();
        for (const p of st.open.filter((x) => x.sym === sym)) app.eng.forceClose(p.id, lb ? lb.c : p.entry, Math.max(p.openT, lb ? lb.t + 300 : p.openT), 'TIME');
        delete st.pending[sym]; lastT = null;
        st.log.push({ type: 'info', t: now, sym, msg: `${F.label(sym)}: the app was closed for more than 6 days, so missed time could not be replayed.` });
      }
      let m1 = [];
      try {
        m1 = lastT
          ? (await SL.fetchBars(sym, { interval: '1m', period1: Math.floor(lastT / 300) * 300 - 3600, period2: now + 60 })).bars
          : (await SL.fetchBars(sym, { interval: '1m', range: '1d' })).bars;
      } catch (e) { app.feed[sym] = { state: 'error', err: e.message }; console.warn(sym, e); }
      if (!lastT) {
        const done = m1.filter((b, i) => i < m1.length - 1 || now - b.t > 900);
        lastT = done.length ? done[done.length - 1].t : (H.length ? H[H.length - 1].t : now);
        st.lastT[sym] = lastT;
      }
      // Warm up indicators with complete 5-min candles before lastT, then rebuild the forming candle
      const cut = Math.floor(lastT / 300) * 300;
      const warm = H.filter((b) => b.t < cut);
      const after = warm.length ? warm[warm.length - 1].t + 300 : 0;
      app.eng.warmup(sym, warm.concat(agg5(m1.filter((b) => b.t >= after && b.t < cut))));
      for (const b of m1) if (b.t >= cut && b.t <= lastT) app.eng.aggregateOnly(sym, b);
      mergeM1(sym, m1);
      pending = pending.concat(completeNew(sym, m1, now));
      if (app.m1[sym] && app.m1[sym].length) updateFeed(sym, now);
    }
    pending.sort((a, b) => a.bar.t - b.bar.t);
    for (const nb of pending) app.eng.processBar(nb.sym, nb.bar);
    if (pending.length > 30) st.log.push({ type: 'info', t: now, msg: `Caught up on ${Math.round(pending.length / 3 / 60)}h of market data missed while the app was closed (those trades are marked ⏱).` });
    closeStale(now);
    app.catchingUp = false;
    save();
  }

  // A market stopped sending data (session end, holiday, halt) with a trade still open: close it at the last price
  function closeStale() {
    for (const p of app.st.open.slice()) {
      const f = app.feed[p.sym];
      if (!f || f.state !== 'closed' || !f.price || f.lastBar < p.openT) continue;
      app.eng.forceClose(p.id, f.price, f.lastBar + 60, 'EOD');
    }
  }

  async function poll() {
    if (app.busy || !app.eng) return;
    app.busy = true;
    try {
      const now = SL.nowSec();
      let fresh = [];
      for (const sym of SL.SYMBOLS) {
        try {
          const lastT = app.st.lastT[sym] || now - 3600;
          const p1 = Math.max(Math.min(lastT, now - 1800) - 60, now - MAX_CATCHUP);
          const r = await SL.fetchBars(sym, { interval: '1m', period1: p1, period2: now + 60 });
          mergeM1(sym, r.bars);
          fresh = fresh.concat(completeNew(sym, r.bars, now));
          updateFeed(sym, now);
        } catch (e) { app.feed[sym] = Object.assign({}, app.feed[sym], { state: 'error', err: e.message }); }
      }
      fresh.sort((a, b) => a.bar.t - b.bar.t);
      for (const nb of fresh) app.eng.processBar(nb.sym, nb.bar);
      closeStale(now);
      if (fresh.length) save();
      renderAll();
    } finally { app.busy = false; }
  }

  // ---------- alerts ----------
  let audio = null;
  function beep(freq) {
    try {
      if (!audio) return;
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = freq; g.gain.value = 0.06;
      o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.18);
    } catch (e) { /* ignore */ }
  }
  function notify(e) {
    if (!app.notify || (e.type !== 'open' && e.type !== 'close')) return;
    const f = ui.feedText(app.st, { type: e.type, id: e.type === 'open' ? e.pos.id : e.trade.id });
    if (!f) return;
    beep(e.type === 'open' ? 620 : e.trade.pnl > 0 ? 880 : 300);
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(f.title, { body: f.sub.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '') }); } catch (err) { /* ignore */ }
    }
  }
  function setNotifyButton() { $('btnNotify').textContent = app.notify ? '🔔 Alerts on' : '🔕 Alerts off'; }

  // ---------- reports written to data/reports ----------
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function tradesCsv(list) {
    const iso = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const head = ['id', 'opened_utc', 'closed_utc', 'market', 'strategy', 'side', 'entry', 'stop_loss', 'take_profit', 'rrr', 'lots', 'exit', 'result', 'held_min', 'pnl_usd', 'r_multiple', 'balance_after', 'note'];
    const rows = list.map((t) => [t.id, iso(t.openT), iso(t.closeT), F.label(t.sym), SL.STRAT[t.strat].name, t.side > 0 ? 'BUY' : 'SELL',
      SL.fmtPrice(t.sym, t.entry), SL.fmtPrice(t.sym, t.sl0 != null ? t.sl0 : t.sl), SL.fmtPrice(t.sym, t.tp), t.rr.toFixed(2), t.lots.toFixed(3), SL.fmtPrice(t.sym, t.exit),
      t.reason, t.holdMin.toFixed(1), t.pnl.toFixed(2), t.r.toFixed(2), t.balanceAfter.toFixed(2), t.note || ''].map(csvCell).join(','));
    return head.join(',') + '\n' + rows.join('\n') + '\n';
  }
  function dayReport(day) {
    const st = app.st, list = st.closed.filter((t) => SL.localDate(t.closeT) === day);
    const s = SL.computeStats(list, st.startBalance), all = SL.computeStats(st.closed, st.startBalance);
    const lines = [`# Scalp Lab demo report - ${day}`, '', 'Paper trading only (virtual money).', '',
      `**Today:** ${s.n} trades, ${s.wins} wins / ${s.losses} losses, win rate ${s.winRate.toFixed(1)}%, net ${F.money(s.net)}`,
      `**All time:** ${all.n} trades, win rate ${all.winRate.toFixed(1)}%, net ${F.money(all.net)}, balance $${st.balance.toFixed(2)} (started $${st.startBalance.toFixed(2)})`, '',
      '| # | Time | Market | Strategy | Side | Entry | SL | TP | RRR | Result | P&L | R |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
    for (const t of list) lines.push(`| ${t.id} | ${F.tLocal(t.openT)}-${F.tLocal(t.closeT)} | ${F.label(t.sym)} | ${F.strat(t.strat)} | ${t.side > 0 ? 'BUY' : 'SELL'} | ${SL.fmtPrice(t.sym, t.entry)} | ${SL.fmtPrice(t.sym, t.sl0 != null ? t.sl0 : t.sl)} | ${SL.fmtPrice(t.sym, t.tp)} | ${F.rr(t.rr)} | ${t.reason} | ${F.money(t.pnl)} | ${F.rf(t.r)} |`);
    return lines.join('\n').replace(/−/g, '-') + '\n';
  }
  let repT = null;
  function scheduleReports() { clearTimeout(repT); repT = setTimeout(writeReports, 3000); }
  async function writeReports() {
    const post = (name, body) => fetch('/api/report?name=' + encodeURIComponent(name), { method: 'POST', body }).catch(() => {});
    await post('trades.csv', tradesCsv(app.st.closed));
    const days = new Set(app.st.closed.slice(-50).map((t) => SL.localDate(t.closeT)));
    for (const d of days) await post(`report-${d}.md`, dayReport(d));
  }

  // ---------- rendering ----------
  function livePos(p) {
    const f = app.feed[p.sym] || {};
    const mid = f.price || p.entry, exit = mid - (p.side * SL.INSTRUMENTS[p.sym].spread) / 2;
    const pnl = (exit - p.entry) * p.side * p.units;
    const dataNow = f.lastBar ? f.lastBar + 60 : SL.nowSec();
    const openMin = Math.max(0, (dataNow - p.openT) / 60);
    return { pnl, r: pnl / p.risk, openMin, leftMin: p.maxHoldMin > 0 ? p.maxHoldMin - openMin : null };
  }
  function equity() {
    const openPnl = app.st.open.reduce((a, p) => a + livePos(p).pnl, 0);
    return { openPnl, equity: app.st.balance + openPnl };
  }

  function chartBars() {
    const { sym, tf } = app.view, m1 = app.m1[sym] || [];
    if (app.viewer) { const c = (app.site && app.site.candles[sym]) || { m1: [], m5: [] }; return tf === '1m' ? c.m1 : c.m5; }
    if (tf === '1m') return m1.slice(-600);
    const done = app.eng ? app.eng.S[sym].bars : app.hist5m[sym] || [];
    const nextBucket = done.length ? done[done.length - 1].t + 300 : 0;
    return done.slice(-500).concat(agg5(m1.filter((b) => b.t >= nextBucket)));
  }

  function renderChart() {
    const bars = chartBars(), { sym, tf } = app.view;
    if (!bars.length) return;
    const key = `${sym}|${tf}|${bars.length}|${bars[0].t}`;
    if (key !== app.chartKey) { ui.chart.setData(sym, tf, bars); app.chartKey = key; }
    else ui.chart.update(bars[bars.length - 1]);
    ui.chart.setTrades(app.st.closed.slice(-300), app.st.open);
    const inst = SL.INSTRUMENTS[sym];
    $('chartLegend').innerHTML = `<span>${inst.label}: ${F.esc(inst.feedNote)}</span><span>Spread used: ${inst.spread} · max leverage 1:${inst.leverage}</span><span>Arrows = entries, dots = exits, dashed lines = SL/TP of open trades</span>`;
    document.querySelectorAll('#symTabs button').forEach((b) => {
      const f = app.feed[b.dataset.sym];
      b.querySelector('.px').textContent = f && f.price ? SL.fmtPrice(b.dataset.sym, f.price) : '';
    });
  }

  function renderPage() {
    const p = app.view.page;
    if (p === 'trades') ui.renderTrades(app.st, app.filters);
    if (p === 'report') { ui.renderReport(app.st); ui.equity.render($('equityChart'), app.st); }
    if (p === 'lab') ui.renderLab(app.bt, app.st, app.st.settings.mode, isEnabled);
  }

  function renderAll() {
    const st = app.st;
    ui.renderStatus(app.feed);
    const day = (app.eng || new SL.Engine({ state: st, baseSec: 60 })).dayStats(SL.nowSec());
    ui.renderKPIs(st, equity(), SL.computeStats(st.closed, st.startBalance), day);
    ui.renderPositions(st, livePos);
    ui.renderFeed(st);
    try { renderChart(); } catch (e) { console.warn('chart', e); }
    renderPage();
    const pb = $('btnPause');
    pb.textContent = st.settings.paused ? '▶ Resume trading' : 'Pause trading';
    pb.className = 'btn' + (st.settings.paused ? ' paused' : '');
    document.title = `$${st.balance.toFixed(2)}${st.open.length ? ` · ${st.open.length} open` : ''} — Scalp Lab demo`;
  }

  function statusBanner() {
    if (app.viewer) return viewerBanner();
    const st = app.st;
    if (st.settings.paused) return banner('Trading is <b>paused</b>. Open trades are still managed (SL/TP/time limit). Press "Resume trading" to continue.', true);
    const active = activeText();
    if (!active.length) {
      return banner(st.settings.mode === 'auto'
        ? '<b>No strategy passed the backtest, so Auto mode is not trading.</b> That is the honest result after spreads. To collect live data anyway, choose "All strategies" in Settings.'
        : '<b>No strategy is switched on.</b> Pick some in Settings.', true);
    }
    const closed = SL.SYMBOLS.every((s) => !app.feed[s] || app.feed[s].state === 'closed');
    let reopen = '';
    if (closed) {
      const now = SL.nowSec();
      for (let t = Math.ceil(now / 900) * 900; t < now + 4 * 86400; t += 900) {
        const z = SL.zoned(t, SL.NY);
        if (z.dow === 0 && z.min === 1080) { reopen = new Date(t * 1000).toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit' }); break; }
      }
    }
    // Local time of the next weekday occurrence of a New York clock time
    const nyLocal = (m) => {
      const now = SL.nowSec();
      for (let t = Math.ceil(now / 300) * 300; t < now + 8 * 86400; t += 300) {
        const z = SL.zoned(t, SL.NY);
        if (z.dow >= 1 && z.dow <= 5 && z.min === m) return new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return '';
    };
    const onlyNas = SL.COMBOS.filter((c) => isEnabled(c.sym, c.strat)).every((c) => c.sym === 'NAS100');
    const idle = SL.SYMBOLS.filter((s) => !SL.COMBOS.some((c) => c.sym === s && isEnabled(c.sym, c.strat))).map(F.label);
    banner((closed ? `Markets are closed right now and reopen${reopen ? ` about <b>${reopen}</b> your time` : ' soon'}. ` : '<b>Running.</b> ') +
      `Active: ${active.join(' · ')}.` +
      (idle.length ? ` Not trading ${idle.join(', ')} (no strategy good enough in the test).` : '') +
      (onlyNas ? ` NAS100 setups only appear in New York hours: about <b>${nyLocal(570)}–${nyLocal(960)}</b> your time, Monday to Friday.` : '') +
      newsLine() + ' Keep this tab and the server window open (if you close them, missed time is replayed when you come back).');
  }

  // ---------- controls ----------
  function setupControls() {
    $('symTabs').innerHTML = SL.SYMBOLS.map((s) => `<button data-sym="${s}" class="${s === app.view.sym ? 'on' : ''}">${F.label(s)}<span class="px"></span></button>`).join('');
    $('symTabs').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      app.view.sym = b.dataset.sym;
      document.querySelectorAll('#symTabs button').forEach((x) => x.classList.toggle('on', x === b));
      renderChart();
    };
    $('tfTabs').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      app.view.tf = b.dataset.tf;
      document.querySelectorAll('#tfTabs button').forEach((x) => x.classList.toggle('on', x === b));
      renderChart();
    };
    $('pageTabs').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      app.view.page = b.dataset.page;
      document.querySelectorAll('#pageTabs button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('.page').forEach((p) => { p.hidden = p.id !== 'page-' + app.view.page; });
      if (app.view.page === 'settings') { if (app.viewer) renderCloudSettings(); else ui.renderSettings(app.st, onSaveSettings, onReset); }
      renderPage();
    };
    $('fSym').innerHTML += SL.SYMBOLS.map((s) => `<option value="${s}">${F.label(s)}</option>`).join('');
    $('fStrat').innerHTML += SL.STRATEGIES.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
    for (const [id, k] of [['fSym', 'sym'], ['fStrat', 'strat'], ['fRes', 'res']]) $(id).onchange = (e) => { app.filters[k] = e.target.value; renderPage(); };
    $('btnCsv').onclick = () => { $('btnCsv').href = URL.createObjectURL(new Blob([tradesCsv(app.st.closed)], { type: 'text/csv' })); };
    $('btnPause').onclick = () => { app.st.settings.paused = !app.st.settings.paused; save(); statusBanner(); renderAll(); };
    $('btnRerun').onclick = async () => { $('labBody').innerHTML = '<p class="muted">Running…</p>'; await refreshBacktest(); statusBanner(); };
    $('btnNotify').onclick = async () => {
      app.notify = !app.notify;
      if (app.notify) {
        try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* ignore */ }
        if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) { /* ignore */ } }
        beep(620);
      }
      ls.set('scalplab.notify', app.notify ? '1' : '0');
      setNotifyButton();
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  }

  function onSaveSettings(s) {
    const prev = app.st.settings, retest = s.maxHoldMin !== prev.maxHoldMin || s.newsFilter !== prev.newsFilter;
    Object.assign(app.st.settings, s);
    if (retest) runTests(true); // these rules change every strategy's results
    runPortfolio(); save(); statusBanner(); renderAll();
  }
  async function onReset() {
    const settings = app.st.settings;
    app.st = SL.newAccount(100); app.st.settings = settings; app.st.settings.paused = false;
    await saveNow();
    location.reload();
  }

  // ---------- cloud viewer (GitHub Pages): read-only, reloads data/site.json every minute ----------
  async function localServer() { try { return (await fetch('api/ping', { cache: 'no-store' })).ok; } catch (e) { return false; } }

  function notifyLog(entry) {
    if (!app.notify) return;
    const f = ui.feedText(app.st, entry);
    if (!f) return;
    beep(entry.type === 'open' ? 620 : 880);
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(f.title, { body: f.sub.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '') }); } catch (e) { /* ignore */ }
    }
  }

  async function loadSite() {
    try {
      const d = await (await fetch('data/site.json?t=' + Date.now(), { cache: 'no-store' })).json();
      const prevT = app.st && app.st.log.length ? app.st.log[app.st.log.length - 1].t : null;
      app.site = d; app.st = d.state; app.bt = d.backtest; app.feed = d.feed || {};
      if (prevT != null) for (const e of app.st.log) if (e.t > prevT && (e.type === 'open' || e.type === 'close')) notifyLog(e);
    } catch (e) { banner('Could not load the latest cloud data (' + F.esc(e.message) + '). Retrying every minute.', true); }
  }

  function viewerBanner() {
    const st = app.st, s = app.site;
    const mins = Math.max(0, Math.round((SL.nowSec() - s.updatedAt) / 60));
    const active = activeText();
    const closed = SL.SYMBOLS.every((x) => !app.feed[x] || app.feed[x].state === 'closed');
    banner(`<b>Cloud demo</b> — runs on GitHub about every 10 minutes, even when your PC is off. Last update <b>${F.tLocal(s.updatedAt)}</b> (${mins} min ago)${mins > 40 ? ' — GitHub is running late; it catches up on the next run' : ''}. ` +
      (st.settings.paused ? 'Trading is <b>paused</b> (see Settings). ' : '') + (closed ? 'Markets are closed right now. ' : '') +
      (active.length ? `Active: ${active.join(' · ')}.` : 'No strategy is active.') + newsLine(), mins > 40 || st.settings.paused);
  }

  function renderCloudSettings() {
    const s = app.st.settings, host = location.hostname.match(/^([^.]+)\.github\.io$/), repo = location.pathname.split('/').filter(Boolean)[0];
    const edit = host && repo ? `https://github.com/${host[1]}/${repo}/edit/main/cloud/settings.json` : null;
    const mode = { auto: 'Auto (best tested strategies for each chart)', markets: 'Auto (best tested strategies for each chart)', all: 'All strategies', custom: 'Custom' }[s.mode] || s.mode;
    const row = (l, v) => `<tr><td>${l}</td><td><b>${v}</b></td></tr>`;
    $('settingsBody').innerHTML = `<p>The cloud demo reads its settings from <code>cloud/settings.json</code> in your GitHub repository. Change them there — the next run (about 10 minutes) uses them.</p>
      <div class="table-wrap"><table>${row('Strategies', F.esc(mode))}${row('Risk per trade', s.riskPct + '%')}${row('Daily loss limit', s.dailyLossPct + '%')}${row('Max trades per day', s.maxTradesPerDay)}${row('Time limit per trade', s.maxHoldMin > 0 ? s.maxHoldMin + ' min' : 'none (until TP or SL; closed at 16:55 New York)')}${row('News filter', s.newsFilter !== false ? 'on' : 'off')}${row('Paused', s.paused ? 'yes' : 'no')}</table></div>
      ${edit ? `<p style="margin-top:12px"><a class="btn" href="${edit}" target="_blank" rel="noopener">Edit settings on GitHub</a></p>` : ''}
      <p class="muted small">"mode" can be "auto", "markets", "all" or "custom"; "maxHoldMin" is minutes (0 = no limit); "newsFilter" and "paused" are true or false. To start again at $100, delete <code>cloud/state.json</code> in the repository.</p>`;
  }

  async function initViewer() {
    app.viewer = true;
    document.body.classList.add('viewer');
    await loadSite();
    if (!app.st) return;
    statusBanner(); renderAll();
    setInterval(async () => { await loadSite(); if (app.st) { statusBanner(); renderAll(); } }, 60000);
  }

  // ---------- start ----------
  async function init() {
    setupControls();
    ui.chart.init($('chart'));
    app.notify = ls.get('scalplab.notify') === '1';
    setNotifyButton();
    if (new URLSearchParams(location.search).has('viewer') || !(await localServer())) return initViewer();
    banner('Loading ~60 days of market history and testing every strategy… (first start takes a few seconds)');
    let st = await loadState();
    if (!st || !st.version) st = SL.newAccount(100);
    st.settings = Object.assign(SL.defaultSettings(), st.settings || {});
    if (st.settings.mode === 'markets') st.settings.mode = 'auto'; // old mode: Auto is now per-chart
    for (const k of ['open', 'closed', 'log']) st[k] = st[k] || [];
    app.st = st;
    ui.renderStatus(app.feed);
    await loadNews();
    await loadHistory();
    runTests(false); // reuses test results younger than 6 hours
    await startLive();
    statusBanner();
    renderAll();
    setInterval(poll, POLL_MS);
    setInterval(statusBanner, 60000);
    setInterval(async () => { await loadNews(); save(); statusBanner(); }, 3600 * 1000);
    setInterval(refreshBacktest, 6 * 3600 * 1000);
  }

  init().catch((e) => { console.error(e); banner('Startup problem: ' + F.esc(e.message) + ' — is the server window still open? Reload the page to retry.', true); });
})(window.SL = window.SL || {});
