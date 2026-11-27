// Strategy rules. Each runs on the close of a 5-minute bar and returns
// { side: 1 (buy) | -1 (sell), slDist, tpDist, note } or null.
// ctx.p holds the settings version being used on that chart (see `variants`); every chart gets its own
// best version from the backtest. The engine enters at the next bar's open and places SL/TP at those
// distances from the real entry. Trades run until TP or SL; everything is closed at 16:55 New York.
(function (SL) {
  'use strict';

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const minStop = (inst) => inst.spread * 3; // spread is never more than 1/3 of the risk
  const weekday = (z) => z.dow >= 1 && z.dow <= 5;
  const fmt = (inst, x) => SL.fmtPrice(inst.id, x);
  const rrOf = (ctx, def) => (ctx.p && ctx.p.rr) || def;
  // Settings versions: the take-profit distance, and for the wider targets three ways to protect profit:
  //   BE   - after +1R the stop moves to +0.1R
  //   Lock - like BE, and after +1.5R the stop moves to +0.5R
  //   Half - after +1R half the position is closed; the rest runs to TP with its stop at +0.1R
  const withExits = (v, from = 2) => (v.p.rr >= from ? [v,
    { p: { ...v.p, be: 1 }, label: v.label + ' · BE' },
    { p: { ...v.p, be: 1, lock: 1 }, label: v.label + ' · Lock' },
    { p: { ...v.p, halfTP: 1 }, label: v.label + ' · Half at 1R' }] : [v]);
  const rrVariants = (list, beFrom = 2) => list.flatMap((rr) => withExits({ p: { rr }, label: `RR ${rr}` }, beFrom));
  // Trading day as brokers count it: 17:00 New York to 17:00 New York
  const tradingDay = (t) => SL.zoned(t + 7 * 3600, SL.NY).date;

  // "All day": London open (07:00 London) to 15:30 New York for EUR/USD and gold; 09:45-15:30 New York for NAS100
  function dayHours(inst, t) {
    const zN = SL.zoned(t, SL.NY);
    if (!weekday(zN) || zN.min >= 930) return false;
    if (inst.id === 'NAS100') return zN.min >= 585;
    return SL.zoned(t, SL.LDN).min >= 420;
  }

  // High/low of bars on `date` (in tz) whose start minute is in [fromMin, toMin), scanning back from i
  function rangeOf(bars, i, tz, date, fromMin, toMin) {
    let hi = -Infinity, lo = Infinity, n = 0;
    for (let j = i; j >= 0 && i - j < 400; j--) {
      const z = SL.zoned(bars[j].t, tz);
      if (z.date !== date) break;
      if (z.min >= fromMin && z.min < toMin) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); n++; }
    }
    return { hi, lo, n };
  }

  // True if no bar before i (same date, start >= fromMin) already closed beyond `level` on that side
  function firstBreak(bars, i, tz, date, fromMin, level, side) {
    for (let j = i - 1; j >= 0 && i - j < 400; j--) {
      const z = SL.zoned(bars[j].t, tz);
      if (z.date !== date || z.min < fromMin) break;
      if (side > 0 ? bars[j].c > level : bars[j].c < level) return false;
    }
    return true;
  }

  // Shared logic for "range then breakout" strategies
  function rangeBreakout(ctx, cfg) {
    const { bars, i, ind, inst } = ctx;
    const b = bars[i], z = SL.zoned(b.t, cfg.tz);
    if (!weekday(z) || z.min < cfg.entryFrom || z.min >= cfg.entryTo) return null;
    if (ctx.tradedToday(cfg.id, z.date, cfg.tz)) return null;
    const atr = ind.atr[i];
    if (!atr) return null;
    const r = rangeOf(bars, i, cfg.tz, z.date, cfg.rangeFrom, cfg.rangeTo);
    if (r.n < cfg.minBars) return null;
    const range = r.hi - r.lo;
    const lim = cfg.rangeLimits && cfg.rangeLimits[inst.id];
    if (range <= 0 || (lim && (range < lim[0] || range > lim[1]))) return null;
    let side = 0;
    if (b.c > r.hi && firstBreak(bars, i, cfg.tz, z.date, cfg.entryFrom, r.hi, 1)) side = 1;
    else if (b.c < r.lo && firstBreak(bars, i, cfg.tz, z.date, cfg.entryFrom, r.lo, -1)) side = -1;
    if (!side) return null;
    const mid = (r.hi + r.lo) / 2;
    let sl = Math.abs(b.c - mid);
    if (sl > cfg.maxChase * range) return null; // price already ran too far from the range
    sl = Math.max(sl, cfg.minAtr * atr, minStop(inst));
    return {
      side, slDist: sl, tpDist: sl * cfg.rr,
      note: `${cfg.rangeName} ${fmt(inst, r.lo)}-${fmt(inst, r.hi)} broken ${side > 0 ? 'up' : 'down'}; SL at range middle`,
    };
  }

  // Session open used by the noise-area strategy
  const NOISE_OPEN = { EURUSD: [SL.LDN, 420], GBPUSD: [SL.LDN, 420], USDJPY: [SL.LDN, 420], GBPJPY: [SL.LDN, 420], XAUUSD: [SL.NY, 500], NAS100: [SL.NY, 570] };
  const FX = ['EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY'];
  const END = ' Runs until TP or SL (closed at 16:55 New York at the latest).';

  const STRATEGIES = [
    {
      id: 'NY_ORB', name: 'NY Opening Range Breakout', short: 'NY ORB',
      symbols: ['NAS100', 'XAUUSD'], maxHoldMin: 0, rr: 2.0,
      variants: [5, 15, 30].flatMap((orMin) => [1.5, 2, 3].flatMap((rr) => withExits({ p: { orMin, rr }, label: `${orMin}-min range · RR ${rr}` }))),
      info: 'Opening range = the first 5, 15 or 30 minutes of the New York cash session (from 09:30 New York; the best length is tested per chart). Buy the first 5-min close above it / sell the first close below it, until 11:00. SL at the middle of the range, TP = 1.5R-3R. Based on the opening-range-breakout research by Zarattini & Aziz (2023).' + END,
      evaluate(ctx) {
        const orMin = (ctx.p && ctx.p.orMin) || 15;
        return rangeBreakout(ctx, {
          id: this.id, tz: SL.NY, rangeName: `NY ${orMin}-min opening range`, rangeFrom: 570, rangeTo: 570 + orMin, minBars: orMin / 5,
          entryFrom: 570 + orMin, entryTo: 660, maxChase: 1.0, minAtr: 0.8, rr: rrOf(ctx, this.rr),
        });
      },
    },
    {
      id: 'LDN_BO', name: 'London Breakout (Asian range)', short: 'London BO',
      symbols: [...FX, 'XAUUSD'], maxHoldMin: 0, rr: 1.5, variants: rrVariants([1, 1.5, 2, 3]),
      info: 'Range = Asian session 00:00-07:00 London time. Trade the first 5-min close outside that range between 07:00 and 10:00 London. SL at the middle of the range, TP = 1R-3R (tested per chart). Ranges that are too small or too wide are skipped.' + END,
      evaluate(ctx) {
        return rangeBreakout(ctx, {
          id: this.id, tz: SL.LDN, rangeName: 'Asian range', rangeFrom: 0, rangeTo: 420, minBars: 70,
          entryFrom: 420, entryTo: 600, maxChase: 0.8, minAtr: 1.0, rr: rrOf(ctx, this.rr),
          rangeLimits: { EURUSD: [0.0012, 0.0060], GBPUSD: [0.0015, 0.0080], USDJPY: [0.15, 1.0], GBPJPY: [0.25, 1.6], XAUUSD: [6, 45] },
        });
      },
    },
    {
      id: 'NOISE', name: 'Intraday Momentum (noise area)', short: 'Noise Mom.',
      symbols: [...FX, 'XAUUSD', 'NAS100'], maxHoldMin: 0, rr: 2.0, variants: rrVariants([1.5, 2, 3]),
      info: 'All day. Measures how far price normally moves away from the session open at each time of day (average of the last 14 days). Every 30 minutes, if price is clearly outside that normal "noise area", it trades in the breakout direction. One trade a day per chart. SL just inside the noise area (0.8-2.5 ATR), TP = 1.5R-3R. Based on "Beat the Market: An Effective Intraday Momentum Strategy" (Zarattini, Aziz & Barbon, 2024).' + END,
      evaluate(ctx) {
        const { bars, i, ind, inst } = ctx;
        const [tz, open] = NOISE_OPEN[inst.id];
        const b = bars[i], z = SL.zoned(b.t, tz), zN = SL.zoned(b.t, SL.NY);
        if (!weekday(z)) return null;
        const m = z.min + 5 - open; // minutes since the session open, at this bar's close
        if (m < 30 || m % 30 !== 0 || zN.min + 5 > 930) return null;
        if (ctx.tradedToday(this.id, z.date, tz)) return null;
        const atr = ind.atr[i];
        if (!atr) return null;
        const target = open + m - 5;
        const days = new Map();
        for (let j = i; j >= 0 && i - j < 4500; j--) {
          const zj = SL.zoned(bars[j].t, tz);
          if (zj.min < open || zj.min > target) continue;
          let d = days.get(zj.date);
          if (!d) { if (days.size >= 15) break; d = {}; days.set(zj.date, d); }
          if (zj.min === open) d.open = bars[j].o;
          if (zj.min === target) d.at = bars[j].c;
        }
        const today = days.get(z.date);
        if (!today || !today.open) return null;
        let sum = 0, n = 0;
        for (const [date, d] of days) if (date !== z.date && d.open && d.at) { sum += Math.abs(d.at / d.open - 1); n++; }
        if (n < 10) return null;
        const noise = sum / n, up = today.open * (1 + noise), lo = today.open * (1 - noise);
        const side = b.c > up ? 1 : b.c < lo ? -1 : 0;
        if (!side) return null;
        const sl = Math.max(clamp(Math.abs(b.c - (side > 0 ? up : lo)) + 0.25 * atr, 0.8 * atr, 2.5 * atr), minStop(inst));
        return { side, slDist: sl, tpDist: sl * rrOf(ctx, this.rr), note: `Broke out of the normal range (±${(noise * 100).toFixed(2)}% from the open) ${m} min after the open` };
      },
    },
    {
      id: 'SWEEP', name: 'Liquidity Sweep Reversal', short: 'Sweep Rev.',
      symbols: [...FX, 'XAUUSD', 'NAS100'], maxHoldMin: 0, rr: 2.0, variants: rrVariants([1.5, 2, 3]),
      info: "All day, pure price action. When price pokes just beyond yesterday's high (or low), triggering the stop orders resting there, and the candle then closes back inside with a strong body, trade the reversal. SL beyond the sweep (0.8-2.5 ATR), TP = 1.5R-3R. One trade a day per chart." + END,
      evaluate(ctx) {
        const { bars, i, ind, inst } = ctx;
        if (i < 15) return null;
        const b = bars[i], p = bars[i - 1];
        if (!dayHours(inst, b.t)) return null;
        const atr = ind.atr[i];
        if (!atr) return null;
        const zN = SL.zoned(b.t, SL.NY);
        if (ctx.tradedToday(this.id, zN.date, SL.NY)) return null;
        const today = tradingDay(b.t);
        let prev = null, hi = -Infinity, lo = Infinity, n = 0;
        for (let j = i - 1; j >= 0 && i - j < 800; j--) {
          const d = tradingDay(bars[j].t);
          if (d === today) continue;
          if (prev == null) prev = d;
          if (d !== prev) break;
          hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); n++;
        }
        if (n < 100) return null;
        const fresh = (level, side) => {
          for (let k = 2; k <= 12; k++) { const c = bars[i - k].c; if (side > 0 ? c > level : c < level) return false; }
          return true;
        };
        const stop = (d) => Math.max(clamp(d, 0.8 * atr, 2.5 * atr), minStop(inst));
        const rr = rrOf(ctx, this.rr);
        const top = Math.max(b.h, p.h), bot = Math.min(b.l, p.l), body = Math.abs(b.c - b.o);
        if (top > hi && top - hi <= 1.5 * atr && b.c < hi && b.c < b.o && body >= 0.4 * (b.h - b.l) && fresh(hi, 1)) {
          const sl = stop(top + 0.2 * atr - b.c);
          return { side: -1, slDist: sl, tpDist: sl * rr, note: `Swept yesterday's high ${fmt(inst, hi)} and closed back below (stop-hunt reversal)` };
        }
        if (bot < lo && lo - bot <= 1.5 * atr && b.c > lo && b.c > b.o && body >= 0.4 * (b.h - b.l) && fresh(lo, -1)) {
          const sl = stop(b.c - (bot - 0.2 * atr));
          return { side: 1, slDist: sl, tpDist: sl * rr, note: `Swept yesterday's low ${fmt(inst, lo)} and closed back above (stop-hunt reversal)` };
        }
        return null;
      },
    },
    {
      id: 'SQUEEZE', name: 'Volatility Squeeze Breakout', short: 'Squeeze BO',
      symbols: [...FX, 'XAUUSD', 'NAS100'], maxHoldMin: 0, rr: 2.0, variants: rrVariants([1.5, 2, 3]),
      info: 'All day. After a very quiet period (Bollinger Bands among the narrowest 20% of the last 10 hours), trade a strong breakout candle that closes outside the band in the direction of the bigger trend (EMA200). SL at the middle band (0.8-2.5 ATR), TP = 1.5R-3R.' + END,
      evaluate(ctx) {
        const { bars, i, ind, inst } = ctx;
        if (i < 130) return null;
        const b = bars[i];
        if (!dayHours(inst, b.t)) return null;
        const atr = ind.atr[i], e200 = ind.ema200[i], mid = ind.bbMid[i];
        if (!atr || e200 == null || mid == null || ind.bbMid[i - 126] == null) return null;
        const bw = (k) => (ind.bbUp[k] - ind.bbLo[k]) / ind.bbMid[k];
        let recent = Infinity;
        for (let k = 1; k <= 6; k++) recent = Math.min(recent, bw(i - k));
        let narrower = 0;
        for (let k = 7; k <= 126; k++) if (bw(i - k) < recent) narrower++;
        if (narrower > 24) return null;
        const range = b.h - b.l, body = Math.abs(b.c - b.o);
        if (range < atr || body < 0.6 * range) return null;
        const stop = (d) => Math.max(clamp(d, 0.8 * atr, 2.5 * atr), minStop(inst));
        const rr = rrOf(ctx, this.rr);
        if (b.c > ind.bbUp[i] && b.c > e200) { const sl = stop(b.c - mid); return { side: 1, slDist: sl, tpDist: sl * rr, note: 'Quiet market (squeeze) broke out upward with a strong candle, with the trend' }; }
        if (b.c < ind.bbLo[i] && b.c < e200) { const sl = stop(mid - b.c); return { side: -1, slDist: sl, tpDist: sl * rr, note: 'Quiet market (squeeze) broke out downward with a strong candle, with the trend' }; }
        return null;
      },
    },
    {
      id: 'IMOM', name: 'Intraday Momentum (last 30 min)', short: 'Intraday Mom.',
      symbols: ['NAS100'], maxHoldMin: 30, rr: 1.5, variants: rrVariants([1, 1.5, 2], 99),
      info: 'If the market rose from the previous 16:00 close to 10:00 New York time, buy at 15:30; if it fell, sell. Exit by 16:00 (30 min, by design), SL = 1.5 x ATR, TP = 1R-2R. Based on "Market Intraday Momentum" (Gao, Han, Li & Zhou, Journal of Financial Economics 2018).',
      evaluate(ctx) {
        const { bars, i, ind, inst } = ctx;
        const b = bars[i], z = SL.zoned(b.t, SL.NY);
        if (!weekday(z) || z.min !== 925) return null; // bar 15:25-15:30
        const atr = ind.atr[i];
        if (!atr) return null;
        let p10 = null, pc = null;
        for (let j = i - 1; j >= 0 && i - j < 800; j--) {
          const zj = SL.zoned(bars[j].t, SL.NY);
          if (zj.date === z.date) { if (zj.min === 595) p10 = bars[j].c; }
          else if (zj.min <= 955 && zj.min >= 900) { pc = bars[j].c; break; }
        }
        if (p10 == null || pc == null) return null;
        const r1 = p10 / pc - 1;
        if (Math.abs(r1) < 0.0005) return null;
        const side = r1 > 0 ? 1 : -1;
        const sl = Math.max(1.5 * atr, minStop(inst));
        return { side, slDist: sl, tpDist: sl * rrOf(ctx, this.rr), note: `Prev close to 10:00 = ${(r1 * 100).toFixed(2)}% -> ${side > 0 ? 'buy' : 'sell'} into the close` };
      },
    },
    {
      id: 'TREND', name: 'Trend Pullback (EMA 20/50/200)', short: 'Trend PB',
      symbols: [...FX, 'XAUUSD', 'NAS100'], maxHoldMin: 0, rr: 1.5,
      variants: rrVariants([1.5, 2, 3]).flatMap((v) => [v, { p: { ...v.p, noLunch: true }, label: v.label + ' · no midday' }]),
      info: 'Trade only with the 5-min trend (EMA20 > EMA50 > EMA200 and EMA50 rising, or the reverse). Wait for a pullback that touches EMA20, then enter when a candle closes back in the trend direction beyond the previous candle. SL behind the last swing (0.8-2.5 ATR), TP = 1.5R-3R. Active in London/New York hours only; one tested version also skips the quiet midday (11:00-13:00 London, 12:00-13:30 New York).' + END,
      evaluate(ctx) {
        const { bars, i, ind, inst } = ctx;
        if (i < 8) return null;
        const b = bars[i], p = bars[i - 1];
        const noMid = !!(ctx.p && ctx.p.noLunch); // skip the quiet midday lull
        if (inst.id === 'NAS100') { const z = SL.zoned(b.t, SL.NY); if (!weekday(z) || z.min < 585 || z.min >= 930 || (noMid && z.min >= 720 && z.min < 810)) return null; }
        else { const z = SL.zoned(b.t, SL.LDN); if (!weekday(z) || z.min < 420 || z.min >= 1020 || (noMid && z.min >= 660 && z.min < 780)) return null; }
        const e20 = ind.ema20[i], e50 = ind.ema50[i], e200 = ind.ema200[i], atr = ind.atr[i], rsi = ind.rsi[i];
        if (e200 == null || !atr || rsi == null || ind.ema50[i - 6] == null) return null;
        const slope = e50 - ind.ema50[i - 6];
        let lo6 = Infinity, hi6 = -Infinity;
        for (let k = 0; k <= 5; k++) { lo6 = Math.min(lo6, bars[i - k].l); hi6 = Math.max(hi6, bars[i - k].h); }
        const stop = (d) => Math.max(clamp(d, 0.8 * atr, 2.5 * atr), minStop(inst));
        const rr = rrOf(ctx, this.rr);
        if (e20 > e50 && e50 > e200 && slope > 0 && b.c > e20 && b.c > b.o && b.c > p.h && rsi >= 45 && rsi <= 70 && b.l > e50) {
          let touched = false;
          for (let k = 1; k <= 3; k++) if (bars[i - k].l <= ind.ema20[i - k] + 0.1 * atr) touched = true;
          if (touched) { const sl = stop(b.c - (lo6 - 0.2 * atr)); return { side: 1, slDist: sl, tpDist: sl * rr, note: 'Uptrend pullback to EMA20, bullish close above prior high' }; }
        }
        if (e20 < e50 && e50 < e200 && slope < 0 && b.c < e20 && b.c < b.o && b.c < p.l && rsi <= 55 && rsi >= 30 && b.h < e50) {
          let touched = false;
          for (let k = 1; k <= 3; k++) if (bars[i - k].h >= ind.ema20[i - k] - 0.1 * atr) touched = true;
          if (touched) { const sl = stop((hi6 + 0.2 * atr) - b.c); return { side: -1, slDist: sl, tpDist: sl * rr, note: 'Downtrend pullback to EMA20, bearish close below prior low' }; }
        }
        return null;
      },
    },
    {
      id: 'MR', name: 'Bollinger Mean Reversion', short: 'Mean Rev.',
      symbols: [...FX, 'XAUUSD', 'NAS100'], maxHoldMin: 0, rr: null,
      variants: [20, 25, 30].map((adx) => ({ p: { adx }, label: `ADX max ${adx}` })),
      info: 'Only in quiet, non-trending markets (ADX below 20, 25 or 30 - tested per chart). After a candle closes outside the Bollinger Band (20, 2) with RSI extreme, enter when price closes back inside. TP = the middle band (RRR varies, 0.8-2.0), SL beyond the extreme (0.7-2 ATR). Skips the London and New York opening rush.' + END,
      evaluate(ctx) {
        const { bars, i, ind, inst } = ctx;
        if (i < 3) return null;
        const b = bars[i], pb = bars[i - 1];
        const zN = SL.zoned(b.t, SL.NY);
        if (!weekday(zN)) return null;
        if (inst.id === 'NAS100') { if (zN.min < 600 || zN.min >= 945) return null; }
        else {
          const zL = SL.zoned(b.t, SL.LDN);
          if ((zL.min >= 415 && zL.min < 450) || (zN.min >= 565 && zN.min < 600)) return null;
        }
        const adxMax = (ctx.p && ctx.p.adx) || 25;
        const adx = ind.adx[i], atr = ind.atr[i], mid = ind.bbMid[i];
        const rsiPrev = ind.rsi[i - 1], loPrev = ind.bbLo[i - 1], upPrev = ind.bbUp[i - 1];
        if (adx == null || adx >= adxMax || !atr || mid == null || rsiPrev == null || loPrev == null) return null;
        let lo3 = Infinity, hi3 = -Infinity;
        for (let k = 0; k <= 2; k++) { lo3 = Math.min(lo3, bars[i - k].l); hi3 = Math.max(hi3, bars[i - k].h); }
        const stop = (d) => Math.max(clamp(d, 0.7 * atr, 2.0 * atr), minStop(inst));
        if (pb.c < loPrev && b.c > ind.bbLo[i] && rsiPrev < 35 && b.c < mid) {
          const sl = stop(b.c - (lo3 - 0.25 * atr)); const tp = mid - b.c;
          if (tp < 0.8 * sl) return null;
          return { side: 1, slDist: sl, tpDist: Math.min(tp, 2 * sl), note: `Closed back inside lower band (ADX ${adx.toFixed(0)}), target middle band` };
        }
        if (pb.c > upPrev && b.c < ind.bbUp[i] && rsiPrev > 65 && b.c > mid) {
          const sl = stop((hi3 + 0.25 * atr) - b.c); const tp = b.c - mid;
          if (tp < 0.8 * sl) return null;
          return { side: -1, slDist: sl, tpDist: Math.min(tp, 2 * sl), note: `Closed back inside upper band (ADX ${adx.toFixed(0)}), target middle band` };
        }
        return null;
      },
    },
  ];

  SL.STRATEGIES = STRATEGIES;
  SL.STRAT = Object.fromEntries(STRATEGIES.map((s) => [s.id, s]));
  SL.COMBOS = STRATEGIES.flatMap((s) => s.symbols.map((sym) => ({ strat: s.id, sym })));
})(window.SL = window.SL || {});
