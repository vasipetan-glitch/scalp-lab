// Paper-trading engine. Deterministic: it only reacts to completed bars, so the live demo and the
// backtest run exactly the same code. Live feeds 1-minute bars, the backtest feeds 5-minute bars.
(function (SL) {
  'use strict';

  const WARMUP = 250;   // 5-min bars of history needed before any trade (EMA200 etc.)
  const KEEP = 3000;    // 5-min bars kept in memory per symbol

  // maxHoldMin 0 = no time limit (trades run until TP/SL; everything is closed at 16:55 New York)
  SL.defaultSettings = () => ({ riskPct: 1, mode: 'auto', paused: false, dailyLossPct: 5, maxTradesPerDay: 12, custom: {}, maxHoldMin: 0, newsFilter: true });

  // ---------- news filter ----------
  // High-impact events that move each market; no new trades from 30 min before to 15 min after.
  SL.NEWS_CCY = { EURUSD: ['USD', 'EUR'], XAUUSD: ['USD'], NAS100: ['USD'] };
  SL.NEWS_BEFORE = 1800; SL.NEWS_AFTER = 900;
  SL.parseNews = (arr) => (Array.isArray(arr) ? arr : [])
    .filter((e) => e.impact === 'High' && (e.country === 'USD' || e.country === 'EUR'))
    .map((e) => ({ t: Math.floor(Date.parse(e.date) / 1000), c: e.country, title: String(e.title || '') }))
    .filter((e) => isFinite(e.t));
  SL.mergeNews = (old, add, now) => {
    const m = new Map();
    for (const e of (old || []).concat(add || [])) m.set(e.t + '|' + e.title, e);
    return [...m.values()].filter((e) => e.t > now - 200 * 86400).sort((a, b) => a.t - b.t);
  };
  SL.newsBlock = (news, sym, t) => {
    if (!news || !news.length) return null;
    const cc = SL.NEWS_CCY[sym];
    for (const e of news) if (t >= e.t - SL.NEWS_BEFORE && t <= e.t + SL.NEWS_AFTER && cc.includes(e.c)) return e;
    return null;
  };

  SL.newAccount = (start = 100) => ({
    version: 1, createdAt: SL.nowSec(), startBalance: start, balance: start,
    open: [], closed: [], log: [], nextId: 1, settings: SL.defaultSettings(),
    lastT: {}, pending: {}, cooldown: {},
  });

  class Engine {
    // opts: { state, baseSec, active(sym) -> [{ strat, p (settings), label, pr (priority) }], onEvent(evt), live }
    constructor(opts) {
      this.st = opts.state;
      this.baseSec = opts.baseSec;
      this.active = opts.active || (() => []);
      this.onEvent = opts.onEvent || (() => {});
      this.live = !!opts.live;
      this.lateAfter = opts.lateAfter || 1200; // seconds after which a processed trade counts as "late"
      this.S = {};
      for (const sym of SL.SYMBOLS) this.S[sym] = { bars: [], ind: new SL.IndicatorSet(), cur: null };
      for (const k of ['pending', 'cooldown', 'lastT']) if (!this.st[k]) this.st[k] = {};
    }

    // Feed historical 5-min bars to warm up indicators (never trades)
    warmup(sym, bars5m) { for (const b of bars5m) this._push5m(sym, b); }

    // Rebuild the forming 5-min candle from 1-min bars that were already processed before a restart
    aggregateOnly(sym, bar) { this._agg(sym, bar, Math.floor(bar.t / 300) * 300); }

    processBar(sym, bar) {
      const S = this.S[sym], st = this.st;
      const bucket = Math.floor(bar.t / 300) * 300;
      if (S.cur && S.cur.t !== bucket) { this._close5m(sym, S.cur); S.cur = null; }
      const pend = st.pending[sym];
      if (pend) { delete st.pending[sym]; this._open(sym, pend, bar.o, bar.t); }
      this._manage(sym, bar);
      this._agg(sym, bar, bucket);
      if (bar.t + this.baseSec >= bucket + 300) { this._close5m(sym, S.cur); S.cur = null; }
      st.lastT[sym] = bar.t;
    }

    _agg(sym, bar, bucket) {
      const S = this.S[sym];
      if (!S.cur || S.cur.t !== bucket) S.cur = { t: bucket, o: bar.o, h: bar.h, l: bar.l, c: bar.c };
      else { S.cur.h = Math.max(S.cur.h, bar.h); S.cur.l = Math.min(S.cur.l, bar.l); S.cur.c = bar.c; }
    }

    _push5m(sym, bar) {
      const S = this.S[sym];
      S.bars.push(bar); S.ind.push(bar);
      if (S.bars.length > KEEP + 500) { S.bars.splice(0, 500); S.ind.trim(500); }
    }

    _close5m(sym, b) {
      this._push5m(sym, b);
      const S = this.S[sym];
      if (S.bars.length < WARMUP || !this._canTrade(sym, b.t + 300)) return;
      const ctx = {
        sym, inst: SL.INSTRUMENTS[sym], bars: S.bars, ind: S.ind, i: S.bars.length - 1,
        tradedToday: (id, date, tz) => this._tradedToday(sym, id, date, tz),
      };
      let best = null, bestPr = -Infinity;
      for (const a of this.active(sym)) {
        const strat = SL.STRAT[a.strat];
        if (!strat || !strat.symbols.includes(sym)) continue;
        ctx.p = a.p || {}; // this chart's tuned settings for the strategy
        let sig = null;
        try { sig = strat.evaluate(ctx); } catch (e) { console.error(strat.id, e); }
        if (!sig || !(sig.slDist > 0) || !(sig.tpDist > 0)) continue;
        const pr = a.pr || 0;
        if (pr > bestPr) { bestPr = pr; best = { ...sig, strat: strat.id, variant: a.label || '', be: (a.p && a.p.be) || 0, maxHoldMin: strat.maxHoldMin || 0, sigT: b.t + 300 }; }
      }
      if (best) this.st.pending[sym] = best;
    }

    // Day statistics for the user's local day containing t
    dayStats(t) {
      const day = SL.localDate(t);
      let pnl = 0, n = 0;
      for (let k = this.st.closed.length - 1; k >= 0; k--) {
        const tr = this.st.closed[k];
        if (tr.closeT < t - 3 * 86400) break;
        if (SL.localDate(tr.closeT) === day) pnl += tr.pnl;
        if (SL.localDate(tr.openT) === day) n++;
      }
      for (const p of this.st.open) if (SL.localDate(p.openT) === day) n++;
      return { pnl, n };
    }

    _canTrade(sym, t) {
      const st = this.st, set = st.settings;
      if (set.paused || st.pending[sym] || st.open.some((p) => p.sym === sym)) return false;
      if (st.cooldown[sym] && t < st.cooldown[sym]) return false;
      const z = SL.zoned(t, SL.NY);
      // Weekend, Friday close, and 15:55-18:15 New York: with a 60-min limit every trade is closed
      // before the 17:00 session end / rollover (wide spreads, settlement prints, futures halt)
      if (z.dow === 6 || (z.dow === 0 && z.min < 1095) || (z.dow === 5 && z.min >= 945)) return false;
      if (z.min >= 955 && z.min < 1095) return false;
      if (set.newsFilter !== false && SL.newsBlock(st.news, sym, t)) return false;
      const d = this.dayStats(t);
      if (d.pnl <= -(set.dailyLossPct / 100) * (st.balance - d.pnl)) return false;
      if (d.n >= set.maxTradesPerDay) return false;
      return true;
    }

    _tradedToday(sym, id, date, tz) {
      const st = this.st;
      if (st.open.some((p) => p.sym === sym && p.strat === id && SL.zoned(p.openT, tz).date === date)) return true;
      for (let k = st.closed.length - 1; k >= 0 && k >= st.closed.length - 60; k--) { // recent trades only
        const tr = st.closed[k];
        if (tr.sym === sym && tr.strat === id && SL.zoned(tr.openT, tz).date === date) return true;
      }
      return false;
    }

    _open(sym, sig, mid, t) {
      const st = this.st, inst = SL.INSTRUMENTS[sym], side = sig.side;
      const entry = mid + side * inst.spread / 2;
      const risk = st.balance * st.settings.riskPct / 100;
      if (!(risk > 0)) return;
      const units = risk / sig.slDist;
      const margin = units * entry / inst.leverage;
      const used = st.open.reduce((a, p) => a + p.margin, 0);
      const label = `${inst.label} ${side > 0 ? 'BUY' : 'SELL'} (${SL.STRAT[sig.strat].short})`;
      if (margin > st.balance - used) {
        this._event({ type: 'skip', t, sym, msg: `Skipped ${label}: not enough free margin (needs $${margin.toFixed(2)})` });
        return;
      }
      const lots = units / inst.lotUnits;
      const caps = [sig.maxHoldMin, st.settings.maxHoldMin].filter((x) => x > 0);
      const hold = caps.length ? Math.min(...caps) : 0; // 0 = no time limit
      const pos = {
        id: st.nextId++, sym, strat: sig.strat, variant: sig.variant || '', side, openT: t, entry,
        sl: entry - side * sig.slDist, sl0: entry - side * sig.slDist, tp: entry + side * sig.tpDist,
        be: sig.be || 0, beMoved: false, // break-even stop: after be x R in profit, the stop moves to +0.1R
        slDist: sig.slDist, tpDist: sig.tpDist, rr: sig.tpDist / sig.slDist,
        units, lots, belowMinLot: lots < inst.minLot, risk, margin,
        maxHoldMin: hold, note: sig.note,
        late: this.live && SL.nowSec() - t > this.lateAfter,
      };
      st.open.push(pos);
      this._event({ type: 'open', t, sym, pos });
    }

    _manage(sym, bar) {
      const inst = SL.INSTRUMENTS[sym], half = inst.spread / 2, base = this.baseSec;
      for (const p of this.st.open.filter((x) => x.sym === sym)) {
        if (bar.t < p.openT) continue;
        const gapOk = bar.t > p.openT;
        // End of the trading day (16:55 New York): close at that candle's open, so nothing is held
        // overnight / over the weekend and the odd settlement print at 17:00 is never used
        if (gapOk) {
          const z = SL.zoned(bar.t, SL.NY);
          if (z.min >= 1015 && z.min < 1080) { this._close(p, bar.o - p.side * half, bar.t, 'EOD'); continue; }
        }
        let exit = null, reason = null, ct = bar.t + base / 2;
        // Longs exit on the bid (mid - half spread), shorts on the ask (mid + half spread).
        // If SL and TP are both touched inside one bar we assume the SL came first (conservative).
        const o = bar.o - p.side * half, lo = bar.l - p.side * half, hi = bar.h - p.side * half;
        if (p.side > 0) {
          if (gapOk && o <= p.sl) { exit = o; reason = 'SL'; ct = bar.t; }
          else if (gapOk && o >= p.tp) { exit = o; reason = 'TP'; ct = bar.t; }
          else if (lo <= p.sl) { exit = p.sl; reason = 'SL'; }
          else if (hi >= p.tp) { exit = p.tp; reason = 'TP'; }
        } else {
          if (gapOk && o >= p.sl) { exit = o; reason = 'SL'; ct = bar.t; }
          else if (gapOk && o <= p.tp) { exit = o; reason = 'TP'; ct = bar.t; }
          else if (hi >= p.sl) { exit = p.sl; reason = 'SL'; }
          else if (lo <= p.tp) { exit = p.tp; reason = 'TP'; }
        }
        if (exit == null && p.maxHoldMin > 0 && bar.t + base - p.openT >= p.maxHoldMin * 60) {
          exit = bar.c - p.side * half; reason = 'TIME'; ct = bar.t + base;
        }
        if (exit != null) {
          if (reason === 'SL' && p.beMoved) reason = 'BE';
          this._close(p, exit, ct, reason);
          continue;
        }
        // Break-even stop: once a finished candle has reached be x R of profit, lock +0.1R from the next candle on
        // (checked after the exits above, so within one candle the original stop always counts first)
        if (p.be > 0 && !p.beMoved && (p.side > 0 ? hi >= p.entry + p.be * p.slDist : lo <= p.entry - p.be * p.slDist)) {
          p.sl = p.entry + p.side * 0.1 * p.slDist;
          p.beMoved = true;
        }
      }
    }

    _close(p, exit, t, reason) {
      const st = this.st;
      const closeT = Math.max(t, p.openT);
      const pnl = (exit - p.entry) * p.side * p.units;
      st.balance += pnl;
      st.open = st.open.filter((x) => x.id !== p.id);
      const tr = { ...p, exit, closeT, reason, pnl, r: pnl / p.risk, balanceAfter: st.balance, holdMin: (closeT - p.openT) / 60 };
      st.closed.push(tr);
      st.cooldown[p.sym] = closeT + 600;
      this._event({ type: 'close', t: closeT, sym: p.sym, trade: tr });
    }

    forceClose(id, mid, t, reason) {
      const p = this.st.open.find((x) => x.id === id);
      if (p) this._close(p, mid - p.side * SL.INSTRUMENTS[p.sym].spread / 2, t, reason);
    }

    _event(e) {
      if (this.live) {
        this.st.log.push(e.type === 'close' ? { type: e.type, t: e.t, sym: e.sym, id: e.trade.id } :
          e.type === 'open' ? { type: e.type, t: e.t, sym: e.sym, id: e.pos.id } : e);
        if (this.st.log.length > 400) this.st.log.splice(0, this.st.log.length - 400);
      }
      this.onEvent(e);
    }
  }
  SL.Engine = Engine;

  // ---------- statistics ----------
  SL.computeStats = function (trades, start) {
    let wins = 0, losses = 0, gp = 0, gl = 0, sumR = 0, sumRR = 0, hold = 0, best = null, worst = null;
    let bal = start, peak = start, maxDD = 0, maxDDpct = 0, rCum = 0, rPeak = 0, maxDDR = 0;
    let streak = 0, maxW = 0, maxL = 0;
    for (const t of trades) {
      if (t.pnl > 0) { wins++; gp += t.pnl; streak = streak > 0 ? streak + 1 : 1; maxW = Math.max(maxW, streak); }
      else { losses++; gl -= t.pnl; streak = streak < 0 ? streak - 1 : -1; maxL = Math.max(maxL, -streak); }
      sumR += t.r; sumRR += t.rr; hold += t.holdMin;
      bal += t.pnl; peak = Math.max(peak, bal);
      if (peak - bal > maxDD) { maxDD = peak - bal; maxDDpct = (maxDD / peak) * 100; }
      rCum += t.r; rPeak = Math.max(rPeak, rCum); maxDDR = Math.max(maxDDR, rPeak - rCum);
      if (!best || t.pnl > best.pnl) best = t;
      if (!worst || t.pnl < worst.pnl) worst = t;
    }
    const n = trades.length;
    return {
      n, wins, losses, winRate: n ? (wins / n) * 100 : 0, gp, gl, net: gp - gl,
      pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
      avgWin: wins ? gp / wins : 0, avgLoss: losses ? gl / losses : 0,
      avgR: n ? sumR / n : 0, totalR: sumR, avgRR: n ? sumRR / n : 0, avgHold: n ? hold / n : 0,
      maxDD, maxDDpct, maxDDR, best, worst, streak, maxW, maxL, endBalance: bal,
    };
  };

  SL.groupBy = (items, keyFn) => {
    const m = {};
    for (const x of items) (m[keyFn(x)] = m[keyFn(x)] || []).push(x);
    return m;
  };

  // ---------- backtest ----------
  // barsBySym: { SYM: [5-min bars] }. Runs the same Engine over history (entries at next bar open).
  // active(sym) -> the strategies (with settings) to run on that chart
  SL.runBacktest = function (barsBySym, active, opts = {}) {
    const st = SL.newAccount(opts.start || 100);
    Object.assign(st.settings, { riskPct: 1, dailyLossPct: 100, maxTradesPerDay: 99 }, opts.settings || {});
    st.news = opts.news || [];
    const eng = new SL.Engine({ state: st, baseSec: 300, active, live: false });
    const syms = Object.keys(barsBySym);
    const idx = Object.fromEntries(syms.map((s) => [s, 0]));
    for (;;) {
      let tMin = Infinity;
      for (const s of syms) { const b = barsBySym[s][idx[s]]; if (b && b.t < tMin) tMin = b.t; }
      if (tMin === Infinity) break;
      for (const s of syms) { const b = barsBySym[s][idx[s]]; if (b && b.t === tMin) { eng.processBar(s, b); idx[s]++; } }
    }
    for (const p of [...st.open]) {
      const bars = barsBySym[p.sym], last = bars[bars.length - 1];
      eng.forceClose(p.id, last.c, last.t + 300, 'END');
    }
    return st;
  };
})(window.SL = window.SL || {});
