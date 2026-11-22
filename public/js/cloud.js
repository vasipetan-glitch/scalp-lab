// One complete "cloud run": load history, (re)select strategies, replay every finished 1-minute candle
// since the last run through the engine, and prepare the dashboard data. No Node or browser APIs here,
// so the same code runs on GitHub (runner/run.mjs) and can be tested in the browser.
(function (SL) {
  'use strict';
  const MAX_CATCHUP = 6.5 * 86400;
  const snapshot = (st) => JSON.stringify({ o: st.open, c: st.closed.length, p: st.pending, s: st.settings, m: st.markets, a: st.auto });

  // opts: { state, backtest, settings, fetchBars(sym, {interval, range | period1, period2}), now }
  SL.cloudStep = async function (opts) {
    const now = opts.now || SL.nowSec(), fetchBars = opts.fetchBars, logs = [];
    let st = opts.state;
    const fresh = !st || !st.version;
    if (fresh) st = SL.newAccount(100);
    st.settings = Object.assign(SL.defaultSettings(), { mode: 'auto' }, st.settings || {}, opts.settings || {});
    if (st.settings.mode === 'markets') st.settings.mode = 'auto'; // old mode name: Auto is now per-chart
    for (const k of ['open', 'closed', 'log']) st[k] = st[k] || [];
    const before = snapshot(st), lastBefore = Object.assign({}, st.lastT);

    // 0) Economic calendar for the news filter (at most once an hour)
    let newsFetched = false;
    if (opts.fetchNews && (!st.newsAt || now - st.newsAt > 3600)) {
      try { st.news = SL.mergeNews(st.news, SL.parseNews(await opts.fetchNews()), now); st.newsAt = now; newsFetched = true; }
      catch (e) { logs.push(`news calendar failed (${e.message})`); }
    }

    // 1) History: 60 days when the backtest is due (every 6 h or after a settings change), else 5 days
    const s = st.settings;
    const settingsKey = JSON.stringify([s.mode, s.riskPct, s.dailyLossPct, s.maxTradesPerDay, s.custom, s.maxHoldMin, s.newsFilter]);
    let bt = opts.backtest && opts.backtest.combos ? opts.backtest : null;
    const btDue = !bt || now - bt.at > 6 * 3600 || bt.settingsKey !== settingsKey;
    const hist = {};
    for (const sym of SL.SYMBOLS) {
      try { hist[sym] = (await fetchBars(sym, { interval: '5m', range: btDue ? '60d' : '5d' })).bars; }
      catch (e) { logs.push(`${sym}: 5-min history failed (${e.message})`); hist[sym] = []; }
    }
    let btChanged = false;
    if (btDue) {
      const nb = SL.runBacktests(hist, { news: st.news, settings: { maxHoldMin: s.maxHoldMin, newsFilter: s.newsFilter } });
      if (nb) {
        bt = nb; bt.settingsKey = settingsKey; btChanged = true;
        SL.applySelection(st, bt);
        bt.portfolio = { stats: SL.runPortfolio(st, hist, bt).stats };
      }
    }
    SL.applySelection(st, bt);

    // 2) Replay all finished 1-minute candles since the last run (same steps as the PC version)
    const events = [];
    const eng = new SL.Engine({
      state: st, baseSec: 60, live: true, lateAfter: 3 * 3600,
      active: (sym) => SL.activeFor(st, bt, sym),
      onEvent: (e) => events.push(e),
    });
    const m1All = {}, feed = {};
    let todo = [];
    for (const sym of SL.SYMBOLS) {
      const H = hist[sym];
      let lastT = st.lastT[sym];
      if (lastT && now - lastT > MAX_CATCHUP) {
        const lb = H.filter((b) => b.t <= lastT).pop();
        for (const p of st.open.filter((x) => x.sym === sym)) eng.forceClose(p.id, lb ? lb.c : p.entry, Math.max(p.openT, lb ? lb.t + 300 : p.openT), 'TIME');
        delete st.pending[sym]; lastT = null;
        logs.push(`${sym}: last run was more than 6 days ago, restarting from now`);
      }
      let m1 = [];
      try {
        const p1 = lastT ? Math.min(Math.floor(lastT / 300) * 300 - 3600, now - 36000) : now - 36000;
        m1 = (await fetchBars(sym, { interval: '1m', period1: p1, period2: now + 60 })).bars;
        // Market closed for a while (weekend): show the last session instead of an empty chart
        if (!m1.length) m1 = (await fetchBars(sym, { interval: '1m', range: '1d' })).bars.filter((b) => !lastT || b.t <= lastT || now - b.t > 900);
      } catch (e) { logs.push(`${sym}: 1-min candles failed (${e.message})`); }
      if (!lastT) {
        const done = m1.filter((b, i) => i < m1.length - 1 || now - b.t > 900);
        lastT = done.length ? done[done.length - 1].t : H.length ? H[H.length - 1].t : now;
        st.lastT[sym] = lastT;
      }
      const cut = Math.floor(lastT / 300) * 300;
      const warm = H.filter((b) => b.t < cut);
      const after = warm.length ? warm[warm.length - 1].t + 300 : 0;
      eng.warmup(sym, warm.concat(SL.agg5(m1.filter((b) => b.t >= after && b.t < cut))));
      for (const b of m1) if (b.t >= cut && b.t <= lastT) eng.aggregateOnly(sym, b);
      for (let i = 0; i < m1.length; i++) {
        if (m1[i].t > lastT && (i < m1.length - 1 || now - m1[i].t > 900)) todo.push({ sym, bar: m1[i] });
      }
      m1All[sym] = m1;
      const last = m1[m1.length - 1];
      feed[sym] = last ? { state: now - last.t < 240 ? 'live' : now - last.t < 1500 ? 'delayed' : 'closed', price: last.c, lastBar: last.t } : { state: 'closed' };
    }
    todo.sort((a, b) => a.bar.t - b.bar.t);
    for (const x of todo) eng.processBar(x.sym, x.bar);
    // A market stopped sending data (session end, holiday, halt) with a trade still open: close at the last price
    for (const p of st.open.slice()) {
      const f = feed[p.sym];
      if (f && f.state === 'closed' && f.price && f.lastBar >= p.openT) eng.forceClose(p.id, f.price, f.lastBar + 60, 'EOD');
    }

    // 3) Save only when something real changed (or at least hourly progress), to keep the repo small
    const advanced = Math.min(...SL.SYMBOLS.map((x) => (st.lastT[x] || 0) - (lastBefore[x] || 0)));
    const changed = fresh || newsFetched || events.length > 0 || snapshot(st) !== before || advanced >= 3600;

    // 4) Dashboard data
    const candles = {};
    for (const sym of SL.SYMBOLS) {
      const done = eng.S[sym].bars, m1 = m1All[sym] || [];
      const next = done.length ? done[done.length - 1].t + 300 : 0;
      candles[sym] = { m5: done.slice(-500).concat(SL.agg5(m1.filter((b) => b.t >= next))), m1: m1.slice(-600) };
    }
    const site = { version: 1, updatedAt: now, state: st, backtest: bt, candles, feed };
    logs.push(`processed ${todo.length} candles, ${events.length} events`);
    return { state: st, backtest: bt, btChanged, events, site, changed, logs };
  };

  // Plain-text (ASCII) alert for phone notifications
  SL.alertText = function (e) {
    const L = (s) => SL.INSTRUMENTS[s].label, f = (s, x) => SL.fmtPrice(s, x);
    if (e.type === 'open') {
      const p = e.pos;
      return { title: `${p.side > 0 ? 'BUY' : 'SELL'} ${L(p.sym)} @ ${f(p.sym, p.entry)}`,
        body: `#${p.id} ${SL.STRAT[p.strat].name}\nSL ${f(p.sym, p.sl)} | TP ${f(p.sym, p.tp)} | RRR 1:${p.rr.toFixed(2)}\nRisk $${p.risk.toFixed(2)}` };
    }
    if (e.type === 'close') {
      const t = e.trade, win = t.pnl > 0;
      return { title: `${win ? 'WIN' : 'LOSS'} ${win ? '+' : '-'}$${Math.abs(t.pnl).toFixed(2)} ${L(t.sym)}`,
        body: `#${t.id} ${t.reason} @ ${f(t.sym, t.exit)} after ${Math.round(t.holdMin)} min\nBalance $${t.balanceAfter.toFixed(2)}` };
    }
    return null;
  };
})(window.SL = window.SL || {});
