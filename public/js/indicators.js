// Incremental indicators on 5-minute bars: EMA 20/50/200, ATR14, RSI14, Bollinger(20,2), ADX14.
// Values are null until the indicator has enough bars.
(function (SL) {
  'use strict';

  const ema = (prev, x, n) => (prev == null ? x : prev + (2 / (n + 1)) * (x - prev));

  class IndicatorSet {
    constructor() {
      this.ema20 = []; this.ema50 = []; this.ema200 = [];
      this.atr = []; this.rsi = []; this.adx = [];
      this.bbMid = []; this.bbUp = []; this.bbLo = [];
      this.s = {
        n: 0, e20: null, e50: null, e200: null,
        pc: null, ph: null, pl: null,
        atr: null, trAcc: 0, trN: 0,
        ag: null, al: null, gAcc: 0, lAcc: 0, chN: 0,
        closes: [],
        trS: null, pS: null, mS: null, dmAcc: [0, 0, 0], dmN: 0,
        adx: null, dxAcc: 0, dxN: 0,
      };
    }

    get length() { return this.atr.length; }

    push(bar) {
      const s = this.s;
      const { h, l, c } = bar;
      s.n++;

      s.e20 = ema(s.e20, c, 20); s.e50 = ema(s.e50, c, 50); s.e200 = ema(s.e200, c, 200);
      this.ema20.push(s.n >= 20 ? s.e20 : null);
      this.ema50.push(s.n >= 50 ? s.e50 : null);
      this.ema200.push(s.n >= 200 ? s.e200 : null);

      // ATR (Wilder)
      const tr = s.pc == null ? h - l : Math.max(h - l, Math.abs(h - s.pc), Math.abs(l - s.pc));
      if (s.atr == null) {
        s.trAcc += tr; s.trN++;
        if (s.trN === 14) s.atr = s.trAcc / 14;
      } else s.atr = (s.atr * 13 + tr) / 14;
      this.atr.push(s.atr);

      // RSI (Wilder)
      if (s.pc != null) {
        const ch = c - s.pc, g = Math.max(ch, 0), lo = Math.max(-ch, 0);
        if (s.ag == null) {
          s.gAcc += g; s.lAcc += lo; s.chN++;
          if (s.chN === 14) { s.ag = s.gAcc / 14; s.al = s.lAcc / 14; }
        } else { s.ag = (s.ag * 13 + g) / 14; s.al = (s.al * 13 + lo) / 14; }
      }
      this.rsi.push(s.ag == null ? null : (s.al === 0 ? 100 : 100 - 100 / (1 + s.ag / s.al)));

      // Bollinger (20, 2)
      s.closes.push(c); if (s.closes.length > 20) s.closes.shift();
      if (s.closes.length === 20) {
        let m = 0; for (const x of s.closes) m += x; m /= 20;
        let v = 0; for (const x of s.closes) v += (x - m) * (x - m);
        const sd = Math.sqrt(v / 20);
        this.bbMid.push(m); this.bbUp.push(m + 2 * sd); this.bbLo.push(m - 2 * sd);
      } else { this.bbMid.push(null); this.bbUp.push(null); this.bbLo.push(null); }

      // ADX (Wilder)
      let adxVal = null;
      if (s.ph != null) {
        const up = h - s.ph, dn = s.pl - l;
        const pdm = up > dn && up > 0 ? up : 0;
        const mdm = dn > up && dn > 0 ? dn : 0;
        if (s.trS == null) {
          s.dmAcc[0] += tr; s.dmAcc[1] += pdm; s.dmAcc[2] += mdm; s.dmN++;
          if (s.dmN === 14) { s.trS = s.dmAcc[0]; s.pS = s.dmAcc[1]; s.mS = s.dmAcc[2]; }
        } else {
          s.trS = s.trS - s.trS / 14 + tr; s.pS = s.pS - s.pS / 14 + pdm; s.mS = s.mS - s.mS / 14 + mdm;
        }
        if (s.trS != null && s.trS > 0) {
          const pdi = 100 * s.pS / s.trS, mdi = 100 * s.mS / s.trS;
          const dx = pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
          if (s.adx == null) { s.dxAcc += dx; s.dxN++; if (s.dxN === 14) s.adx = s.dxAcc / 14; }
          else s.adx = (s.adx * 13 + dx) / 14;
          adxVal = s.adx;
        }
      }
      this.adx.push(adxVal);

      s.pc = c; s.ph = h; s.pl = l;
    }

    // Drop the oldest n values (keeps memory bounded in long live sessions)
    trim(n) {
      for (const k of ['ema20', 'ema50', 'ema200', 'atr', 'rsi', 'adx', 'bbMid', 'bbUp', 'bbLo']) this[k].splice(0, n);
    }
  }

  SL.IndicatorSet = IndicatorSet;
})(window.SL = window.SL || {});
