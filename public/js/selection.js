// Strategy selection, shared by the PC dashboard and the cloud runner.
// Every chart is treated on its own: each strategy is tuned and tested separately on each chart, and only
// the ones that prove themselves on that chart are used there.
//   1. Training (first 2/3 of the history): try every settings version, keep the best one.
//   2. Unseen test (last 1/3): the chosen version must also make money on data it was not tuned on.
//   3. Overall: enough trades, profitable after spreads.
// Auto mode then trades the best (up to 2) passing strategies per chart.
(function (SL) {
  'use strict';
  const key = (sym, id) => sym + ':' + id;
  const MAX_PER_CHART = 2;
  const stats = (tr) => SL.computeStats(tr, 100);

  // Which strategies (with their tuned settings) run on a chart right now: [{ strat, p, label, pr }]
  SL.activeFor = function (st, bt, sym) {
    const mode = st.settings.mode;
    const combos = (bt && bt.combos) || [];
    const entry = (id) => {
      const c = combos.find((x) => x.sym === sym && x.strat === id);
      return { strat: id, p: c ? c.p : {}, label: c ? c.label : '', pr: c ? c.score : 0 };
    };
    const forChart = SL.STRATEGIES.filter((s) => s.symbols.includes(sym));
    if (mode === 'all') return forChart.map((s) => entry(s.id));
    if (mode === 'custom') return forChart.filter((s) => (st.settings.custom || {})[key(sym, s.id)]).map((s) => entry(s.id));
    return ((st.plan && st.plan[sym]) || []).map((a) => Object.assign({}, a)); // auto: the per-chart plan
  };
  SL.isActive = (st, bt, sym, id) => SL.activeFor(st, bt, sym).some((a) => a.strat === id);

  // H = { SYM: [5-min bars] }; opts = { news, settings: { maxHoldMin, newsFilter } }
  SL.runBacktests = function (H, opts = {}) {
    const syms = SL.SYMBOLS.filter((s) => H[s] && H[s].length > 400);
    if (!syms.length) return null;
    const from = Math.min(...syms.map((s) => H[s][250].t));
    const to = Math.max(...syms.map((s) => H[s][H[s].length - 1].t + 300));
    const split = from + ((to - from) * 2) / 3;
    const combos = [];
    let tested = 0;
    for (const sym of syms) {
      for (const strat of SL.STRATEGIES.filter((s) => s.symbols.includes(sym))) {
        const variants = strat.variants && strat.variants.length ? strat.variants : [{ p: {}, label: '' }];
        let best = null;
        for (const v of variants) {
          const act = [{ strat: strat.id, p: v.p, label: v.label }];
          const tr = SL.runBacktest({ [sym]: H[sym] }, (s) => (s === sym ? act : []), { news: opts.news, settings: opts.settings }).closed;
          tested++;
          const c = { sym, strat: strat.id, p: v.p, label: v.label, all: stats(tr), early: stats(tr.filter((t) => t.openT < split)), late: stats(tr.filter((t) => t.openT >= split)) };
          // The version is picked on the training part only; the unseen part is not looked at here
          const fit = (x) => (x.early.n >= 5 ? x.early.totalR : -1e9 + x.early.totalR);
          if (!best || fit(c) > fit(best)) best = c;
        }
        const { all, early, late } = best;
        let selected = false, reason;
        if (all.n < 15) reason = `too few trades (${all.n})`;
        else if (early.totalR <= 0) reason = 'no settings version made money in training';
        else if (late.totalR <= 0) reason = 'failed on the unseen recent data';
        else if (all.avgR <= 0.03 || all.pf < 1.1) reason = 'edge too small after costs';
        else { selected = true; reason = 'made money in training AND on unseen data'; }
        combos.push({ ...best, versions: variants.length, selected, reason, score: all.avgR });
      }
    }
    return { from, to, split, combos, tested, at: SL.nowSec() };
  };

  // Auto mode plan: for each chart, its own best (up to 2) passing strategies with their tuned settings
  SL.applySelection = function (st, bt) {
    if (!bt) return;
    const plan = {};
    for (const sym of SL.SYMBOLS) {
      plan[sym] = bt.combos.filter((c) => c.sym === sym && c.selected)
        .sort((a, b) => b.score - a.score).slice(0, MAX_PER_CHART)
        .map((c) => ({ strat: c.strat, p: c.p, label: c.label, pr: c.score }));
    }
    st.plan = plan;
  };

  // Backtest of the currently active set on all charts together (same rules as live)
  SL.runPortfolio = function (st, H, bt) {
    const bars = {};
    for (const s of SL.SYMBOLS) if (H[s] && H[s].length > 400) bars[s] = H[s];
    const set = st.settings;
    const res = SL.runBacktest(bars, (sym) => SL.activeFor(st, bt, sym), {
      settings: { riskPct: set.riskPct, dailyLossPct: set.dailyLossPct, maxTradesPerDay: set.maxTradesPerDay, maxHoldMin: set.maxHoldMin, newsFilter: set.newsFilter },
      news: st.news,
    });
    return { stats: SL.computeStats(res.closed, 100), trades: res.closed };
  };

  // 5-min candles from 1-min candles
  SL.agg5 = function (bars) {
    const out = [];
    for (const b of bars) {
      const t = Math.floor(b.t / 300) * 300, last = out[out.length - 1];
      if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; }
      else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c });
    }
    return out;
  };
})(window.SL = window.SL || {});
