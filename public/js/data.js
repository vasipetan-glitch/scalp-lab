// Instruments, market data (via the local proxy) and time-zone helpers.
(function (SL) {
  'use strict';

  // Costs are typical retail CFD spreads; leverage = EU retail (ESMA) limits.
  SL.INSTRUMENTS = {
    EURUSD: { id: 'EURUSD', label: 'EUR/USD', yahoo: 'EURUSD=X', digits: 5, spread: 0.00008, lotUnits: 100000, minLot: 0.01, leverage: 30, unitName: 'units', feedNote: 'spot FX (near real time)' },
    XAUUSD: { id: 'XAUUSD', label: 'XAU/USD', yahoo: 'GC=F', digits: 2, spread: 0.30, lotUnits: 100, minLot: 0.01, leverage: 20, unitName: 'oz', feedNote: 'COMEX gold futures as proxy for spot' },
    NAS100: { id: 'NAS100', label: 'NAS100', yahoo: 'NQ=F', digits: 1, spread: 1.5, lotUnits: 1, minLot: 0.1, leverage: 20, unitName: '$/pt', feedNote: 'E-mini Nasdaq-100 futures as proxy' },
  };
  SL.SYMBOLS = Object.keys(SL.INSTRUMENTS);

  // ---------- time-zone helpers ----------
  SL.NY = 'America/New_York';
  SL.LDN = 'Europe/London';
  const fmts = {};
  const cache = new Map();
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // Returns { date:'YYYY-MM-DD', min: minutes since midnight, dow: 0..6 } for unix seconds t in time zone tz
  SL.zoned = function (t, tz) {
    const key = tz + t;
    let v = cache.get(key);
    if (v) return v;
    if (!fmts[tz]) {
      fmts[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short',
      });
    }
    const p = {};
    for (const part of fmts[tz].formatToParts(new Date(t * 1000))) p[part.type] = part.value;
    v = { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute, dow: DOW[p.weekday] };
    if (cache.size > 300000) cache.clear();
    cache.set(key, v);
    return v;
  };

  SL.localDate = function (t) {
    const d = new Date(t * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  SL.nowSec = () => Math.floor(Date.now() / 1000);

  // ---------- market data ----------
  // Parses Yahoo chart JSON into ascending, de-duplicated bars {t,o,h,l,c} aligned to the interval.
  SL.parseYahoo = function (json, intervalSec) {
    const r = json && json.chart && json.chart.result && json.chart.result[0];
    if (!r || !r.timestamp) return { bars: [], meta: r ? r.meta : null };
    const q = r.indicators.quote[0];
    const map = new Map();
    for (let i = 0; i < r.timestamp.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
      if (o == null || h == null || l == null || c == null) continue;
      const t = Math.floor(r.timestamp[i] / intervalSec) * intervalSec;
      const prev = map.get(t);
      if (prev) { prev.h = Math.max(prev.h, h); prev.l = Math.min(prev.l, l); prev.c = c; }
      else map.set(t, { t, o, h, l, c });
    }
    const bars = [...map.values()].sort((a, b) => a.t - b.t);
    return { bars, meta: r.meta };
  };

  // opts: { interval:'1m'|'5m', range } or { interval, period1, period2 }
  SL.fetchBars = async function (symbol, opts) {
    const inst = SL.INSTRUMENTS[symbol];
    const p = new URLSearchParams({ symbol: inst.yahoo, interval: opts.interval });
    if (opts.period1) { p.set('period1', String(opts.period1)); p.set('period2', String(opts.period2)); }
    else p.set('range', opts.range);
    const res = await fetch('/api/chart?' + p.toString());
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
    if (json.chart && json.chart.error) throw new Error(json.chart.error.description || 'Yahoo error');
    return SL.parseYahoo(json, opts.interval === '1m' ? 60 : 300);
  };

  SL.fmtPrice = (symbol, x) => (x == null || isNaN(x) ? '-' : Number(x).toFixed(SL.INSTRUMENTS[symbol].digits));
})(window.SL = window.SL || {});
