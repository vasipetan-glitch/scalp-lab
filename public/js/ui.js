// Rendering: KPIs, positions, activity feed, trade history, report, strategy lab, settings, charts.
(function (SL) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const round = (x, d) => Math.round(x * Math.pow(10, d)) / Math.pow(10, d) + 0; // "+ 0" turns -0 into 0
  const money = (x, sign = true) => {
    if (x == null || isNaN(x)) return '-';
    const v = round(x, 2);
    return (sign && v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toFixed(2);
  };
  const cls = (x) => (x >= 0.005 ? 'pos' : x <= -0.005 ? 'neg' : '');
  const pct = (x, d = 1) => (x == null || !isFinite(x) ? '-' : round(x, d).toFixed(d) + '%');
  const rr = (x) => (x ? '1:' + x.toFixed(2).replace(/\.?0+$/, '') : '-');
  const rf = (x) => { if (x == null || isNaN(x)) return '-'; const v = round(x, 2); return (v > 0 ? '+' : '') + v.toFixed(2) + 'R'; };
  const pf = (x) => (x === Infinity ? '∞' : x ? x.toFixed(2) : '-');
  const tLocal = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dLocal = (t) => new Date(t * 1000).toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + tLocal(t);
  const dur = (m) => (m < 1 ? '<1m' : Math.round(m) + 'm');
  const strat = (id) => (SL.STRAT[id] ? SL.STRAT[id].short : id);
  const stratV = (t) => strat(t.strat) + (t.variant ? ` (${t.variant})` : ''); // strategy + this chart's settings
  const label = (sym) => SL.INSTRUMENTS[sym].label;
  const side = (s) => `<span class="tag ${s > 0 ? 'buy' : 'sell'}">${s > 0 ? 'BUY' : 'SELL'}</span>`;
  const lots = (p) => p.lots.toFixed(p.lots < 0.1 ? 3 : 2) + (p.belowMinLot ? ` <span class="warnmark" title="Below a typical broker minimum (${SL.INSTRUMENTS[p.sym].minLot} lot). With $100 a real broker could not open this size at this risk.">⚠</span>` : '');
  const ui = (SL.ui = { fmt: { money, cls, pct, rr, rf, pf, tLocal, dLocal, dur, strat, label, esc } });

  ui.renderStatus = function (feed) {
    $('status').innerHTML = SL.SYMBOLS.map((sym) => {
      const f = feed[sym] || { state: 'loading' };
      const txt = { live: 'live', delayed: 'delayed', closed: 'market closed', error: 'feed error', loading: 'loading…' }[f.state] || f.state;
      return `<span class="pill" title="${esc(SL.INSTRUMENTS[sym].feedNote)}${f.lastBar ? ' · last candle ' + dLocal(f.lastBar) : ''}"><span class="dot ${f.state}"></span>${label(sym)} <b>${f.price ? SL.fmtPrice(sym, f.price) : ''}</b> <span class="muted">${txt}</span></span>`;
    }).join('');
  };

  ui.renderKPIs = function (st, eq, s, day) {
    const net = st.balance - st.startBalance;
    const k = (l, v, sub, c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${v}</div><div class="s">${sub}</div></div>`;
    $('kpis').innerHTML = [
      k('Balance', '$' + st.balance.toFixed(2), 'started with $' + st.startBalance.toFixed(2)),
      k('Equity', '$' + eq.equity.toFixed(2), 'open P&L ' + money(eq.openPnl), cls(eq.openPnl)),
      k('Net P&L', money(net), pct((net / st.startBalance) * 100, 2) + ' total', cls(net)),
      k('Trades', String(s.n), `${s.wins} won · ${s.losses} lost`),
      k('Win rate', s.n ? pct(s.winRate) : '-', s.n ? 'avg RRR ' + rr(s.avgRR) : 'no closed trades yet'),
      k('Profit factor', s.n ? pf(s.pf) : '-', 'gross win / gross loss'),
      k('Avg result', s.n ? rf(s.avgR) : '-', s.n ? money(s.net / s.n) + ' per trade' : '1R = risk per trade', cls(s.avgR)),
      k('Max drawdown', s.n ? pct(s.maxDDpct) : '-', s.n ? money(-s.maxDD) : 'peak to lowest point'),
      k('Today', money(day.pnl), `${day.n} trade${day.n === 1 ? '' : 's'} today`, cls(day.pnl)),
    ].join('');
  };

  ui.renderPositions = function (st, live) {
    $('openCount').textContent = st.open.length ? `${st.open.length} open` : '';
    if (!st.open.length) { $('positions').innerHTML = '<div class="empty">No open trades. The engine checks for setups every 5 minutes.</div>'; return; }
    $('positions').innerHTML = `<table><tr><th>Trade</th><th class="r">Entry</th><th class="r">SL / TP</th><th class="r">P&L</th><th class="r">Open</th></tr>` +
      st.open.map((p) => {
        const l = live(p);
        return `<tr><td>${side(p.side)} <b>${label(p.sym)}</b><div class="muted small">#${p.id} ${esc(stratV(p))} · ${rr(p.rr)} · ${lots(p)} lot</div></td>
          <td class="r">${SL.fmtPrice(p.sym, p.entry)}<div class="muted small">${tLocal(p.openT)}</div></td>
          <td class="r">${p.beMoved ? `<span class="pos" title="Stop moved to lock +0.1R">${SL.fmtPrice(p.sym, p.sl)} BE</span>` : `<span class="neg">${SL.fmtPrice(p.sym, p.sl)}</span>`}<div class="pos">${SL.fmtPrice(p.sym, p.tp)}</div></td>
          <td class="r ${cls(l.pnl)}"><b>${money(l.pnl)}</b><div class="small">${rf(l.r)}</div></td>
          <td class="r">${Math.round(l.openMin)}m${l.leftMin != null ? `<div class="muted small">${Math.max(0, Math.round(l.leftMin))}m left</div>` : ''}</td></tr>`;
      }).join('') + '</table>';
  };

  ui.feedText = function (st, e) {
    const find = (id) => st.open.find((p) => p.id === id) || st.closed.find((p) => p.id === id);
    if (e.type === 'open') {
      const p = find(e.id); if (!p) return null;
      return { cls: 'open', title: `${p.side > 0 ? 'BUY' : 'SELL'} ${label(p.sym)} @ ${SL.fmtPrice(p.sym, p.entry)} — #${p.id} ${stratV(p)}`,
        sub: `SL ${SL.fmtPrice(p.sym, p.sl)} · TP ${SL.fmtPrice(p.sym, p.tp)} · RRR ${rr(p.rr)} · risk $${p.risk.toFixed(2)}${p.late ? ' · processed later (app was closed)' : ''}<br>${esc(p.note || '')}` };
    }
    if (e.type === 'close') {
      const p = st.closed.find((x) => x.id === e.id); if (!p) return null;
      const why = { TP: 'take profit hit', SL: 'stop loss hit', BE: 'break-even stop hit (locked +0.1R)', TIME: 'time limit reached', EOD: 'closed at the end of the trading day (16:55 New York)', MANUAL: 'closed by you', END: 'closed' }[p.reason] || p.reason;
      return { cls: p.pnl > 0 ? 'win' : 'loss', title: `${p.pnl > 0 ? 'WIN' : 'LOSS'} ${money(p.pnl)} (${rf(p.r)}) — #${p.id} ${label(p.sym)} ${p.side > 0 ? 'BUY' : 'SELL'}`,
        sub: `${why} @ ${SL.fmtPrice(p.sym, p.exit)} after ${dur(p.holdMin)} · balance $${p.balanceAfter.toFixed(2)}` };
    }
    if (e.type === 'skip' || e.type === 'info') return { cls: 'skip', title: esc(e.msg), sub: '' };
    return null;
  };

  ui.renderFeed = function (st) {
    const items = st.log.slice(-80).reverse().map((e) => {
      const f = ui.feedText(st, e); if (!f) return '';
      return `<div class="ev ${f.cls}"><div class="t">${tLocal(e.t)}</div><div><div>${f.title}</div>${f.sub ? `<div class="sub">${f.sub}</div>` : ''}</div></div>`;
    }).join('');
    $('feed').innerHTML = items || '<div class="empty">Nothing yet. Trades appear here the moment they open or close.</div>';
  };

  ui.renderTrades = function (st, f) {
    let list = st.closed.slice().reverse();
    if (f.sym) list = list.filter((t) => t.sym === f.sym);
    if (f.strat) list = list.filter((t) => t.strat === f.strat);
    if (f.res === 'win') list = list.filter((t) => t.pnl > 0);
    if (f.res === 'loss') list = list.filter((t) => t.pnl <= 0);
    if (!list.length) { $('tradesTable').innerHTML = '<div class="empty">No closed trades yet.</div>'; return; }
    $('tradesTable').innerHTML = `<table><tr><th>#</th><th>Opened</th><th>Market</th><th>Strategy</th><th>Side</th><th class="r">Entry</th><th class="r">SL</th><th class="r">TP</th><th class="r">RRR</th><th class="r">Lots</th><th class="r">Exit</th><th>Result</th><th class="r">Held</th><th class="r">P&L</th><th class="r">R</th><th class="r">Balance</th></tr>` +
      list.slice(0, 500).map((t) => `<tr><td>${t.id}</td><td>${dLocal(t.openT)}${t.late ? ' <span class="warnmark" title="Processed after the fact: the app was closed when this happened">⏱</span>' : ''}</td><td><b>${label(t.sym)}</b></td><td>${esc(stratV(t))}</td><td>${side(t.side)}</td>
        <td class="r">${SL.fmtPrice(t.sym, t.entry)}</td><td class="r">${SL.fmtPrice(t.sym, t.sl0 != null ? t.sl0 : t.sl)}</td><td class="r">${SL.fmtPrice(t.sym, t.tp)}</td><td class="r">${rr(t.rr)}</td><td class="r">${lots(t)}</td>
        <td class="r">${SL.fmtPrice(t.sym, t.exit)}</td><td><span class="tag ${t.reason}">${t.reason}</span></td><td class="r">${dur(t.holdMin)}</td>
        <td class="r ${cls(t.pnl)}"><b>${money(t.pnl)}</b></td><td class="r ${cls(t.r)}">${rf(t.r)}</td><td class="r">$${t.balanceAfter.toFixed(2)}</td></tr>`).join('') + '</table>';
  };

  function groupTable(title, groups, start) {
    const rows = Object.entries(groups).map(([k, arr]) => [k, SL.computeStats(arr, start)]);
    if (!rows.length) return '';
    return `<div><h3>${title}</h3><div class="table-wrap"><table><tr><th></th><th class="r">Trades</th><th class="r">Won</th><th class="r">Lost</th><th class="r">Win rate</th><th class="r">Net P&L</th><th class="r">PF</th><th class="r">Avg R</th></tr>` +
      rows.map(([k, s]) => `<tr><td><b>${esc(k)}</b></td><td class="r">${s.n}</td><td class="r">${s.wins}</td><td class="r">${s.losses}</td><td class="r">${pct(s.winRate)}</td><td class="r ${cls(s.net)}">${money(s.net)}</td><td class="r">${pf(s.pf)}</td><td class="r ${cls(s.avgR)}">${rf(s.avgR)}</td></tr>`).join('') + '</table></div></div>';
  }

  ui.renderReport = function (st) {
    const tr = st.closed, s = SL.computeStats(tr, st.startBalance);
    $('reportNote').textContent = `since ${dLocal(st.createdAt)}`;
    if (!tr.length) { $('reportBody').innerHTML = '<div class="empty">The report fills in as soon as the first trade closes.</div>'; return; }
    const stat = (l, v, c = '') => `<div class="stat"><div class="l">${l}</div><div class="v ${c}">${v}</div></div>`;
    const days = SL.groupBy(tr.slice().reverse(), (t) => SL.localDate(t.closeT));
    $('reportBody').innerHTML = `<div class="stats">
      ${stat('Closed trades', s.n)}${stat('Wins / losses', `${s.wins} / ${s.losses}`)}${stat('Win rate', pct(s.winRate))}
      ${stat('Net P&L', money(s.net), cls(s.net))}${stat('Profit factor', pf(s.pf))}${stat('Avg planned RRR', rr(s.avgRR))}
      ${stat('Avg win', money(s.avgWin), 'pos')}${stat('Avg loss', money(-s.avgLoss), 'neg')}${stat('Avg result', rf(s.avgR), cls(s.avgR))}
      ${stat('Expectancy', money(s.net / s.n) + ' / trade', cls(s.net))}${stat('Max drawdown', `${pct(s.maxDDpct)} (${money(-s.maxDD)})`)}${stat('Avg time in trade', dur(s.avgHold))}
      ${stat('Best trade', money(s.best.pnl), 'pos')}${stat('Worst trade', money(s.worst.pnl), 'neg')}${stat('Longest streak', `${s.maxW} wins / ${s.maxL} losses`)}
    </div><div class="two">
      ${groupTable('By market', SL.groupBy(tr, (t) => label(t.sym)), st.startBalance)}
      ${groupTable('By strategy', SL.groupBy(tr, (t) => SL.STRAT[t.strat] ? SL.STRAT[t.strat].name : t.strat), st.startBalance)}
      ${groupTable('By exit', SL.groupBy(tr, (t) => ({ TP: 'Take profit', SL: 'Stop loss', BE: 'Break-even stop', TIME: 'Time limit', EOD: 'End of day (16:55 NY)', MANUAL: 'Manual', END: 'Other' }[t.reason] || t.reason)), st.startBalance)}
      ${groupTable('By day (local time)', days, st.startBalance)}
    </div>`;
  };

  ui.renderLab = function (bt, st, mode, isActive) {
    if (!bt) return;
    const days = Math.round((bt.to - bt.from) / 86400);
    const p = bt.portfolio, ps = p && p.stats;
    const modeName = { auto: 'Auto mode', markets: 'Auto mode', all: '"All strategies" mode', custom: 'Your custom selection' }[mode] || 'Current selection';
    const part = (s) => (s.n ? rf(s.totalR) + ` <span class="muted small">(${s.n})</span>` : '-');
    const head = '<tr><th>Strategy</th><th>Best settings</th><th class="r">Training</th><th class="r">Unseen test</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">Avg R</th><th class="r">Profit factor</th><th class="r">Max DD</th><th>Verdict</th><th>Trading now</th></tr>';
    const row = (c) => `<tr><td><b>${SL.STRAT[c.strat].name}</b></td><td>${esc(c.label || 'standard')} <span class="muted small">(best of ${c.versions || 1})</span></td>
        <td class="r ${cls(c.early.totalR)}">${part(c.early)}</td><td class="r ${cls(c.late.totalR)}">${part(c.late)}</td>
        <td class="r">${c.all.n}</td><td class="r">${c.all.n ? pct(c.all.winRate) : '-'}</td><td class="r ${cls(c.all.avgR)}">${c.all.n ? rf(c.all.avgR) : '-'}</td>
        <td class="r">${c.all.n ? pf(c.all.pf) : '-'}</td><td class="r">${c.all.n ? '−' + c.all.maxDDR.toFixed(1) + 'R' : '-'}</td>
        <td><span class="tag ${c.selected ? 'on' : 'off'}">${c.selected ? 'PASS' : 'FAIL'}</span> <span class="muted small">${esc(c.reason)}</span></td>
        <td>${isActive(c.sym, c.strat) ? '<span class="tag on">ON</span>' : '<span class="tag off">off</span>'}</td></tr>`;
    const charts = SL.SYMBOLS.map((sym) => {
      const list = bt.combos.filter((c) => c.sym === sym).sort((a, b) => (b.selected - a.selected) || (b.all.avgR - a.all.avgR));
      if (!list.length) return '';
      const on = list.filter((c) => isActive(c.sym, c.strat));
      return `<h3>${label(sym)} — ${on.length ? 'trading: ' + on.map((c) => esc(SL.STRAT[c.strat].short + (c.label ? ' (' + c.label + ')' : ''))).join(' + ') : 'nothing passed, so not trading this chart'}</h3>
        <div class="table-wrap"><table>${head}${list.map(row).join('')}</table></div>`;
    }).join('');
    $('labBody').innerHTML = `
      <p class="muted">Data ${dLocal(bt.from)} → ${dLocal(bt.to)} (${days} days, 5-min candles, ${bt.tested || '?'} backtests). Every chart is tested on its own. For each strategy, several settings versions are tried on the <b>training</b> part (first 2/3 of the history) and the best one is kept; it must then also make money on the <b>unseen test</b> part (last 1/3), which it was not tuned on. Each trade pays the spread; 1R = the money risked on one trade; (n) = number of trades.</p>
      ${ps ? `<div class="banner ${ps.net >= 0 ? '' : 'warn'}"><b>${modeName} on this history:</b> $100 → <b>$${ps.endBalance.toFixed(2)}</b> (${money(ps.net)}) · ${ps.n} trades · win rate ${pct(ps.winRate)} · profit factor ${pf(ps.pf)} · max drawdown ${pct(ps.maxDDpct)}${ps.n === 0 ? ' — no strategy is active, so nothing would trade.' : ''}</div>` : ''}
      ${charts}
      <h3>The strategies</h3>
      <ul class="prose">${SL.STRATEGIES.map((s) => `<li><b>${s.name}</b> (${s.symbols.map(label).join(', ')}): ${esc(s.info)}</li>`).join('')}</ul>`;
  };

  ui.renderSettings = function (st, onSave, onReset) {
    const s = st.settings, custom = s.custom || {};
    const radio = (v, t) => `<label><input type="radio" name="mode" value="${v}" ${s.mode === v ? 'checked' : ''}> ${t}</label>`;
    $('settingsBody').innerHTML = `<div class="form">
      <label for="sRisk"><b>Risk per trade</b></label><div><input type="number" id="sRisk" min="0.25" max="3" step="0.25" value="${s.riskPct}"> % of balance</div>
      <div class="help">1% of $100 = $1 at risk per trade. The lot size is calculated from the distance to the stop loss.</div>
      <label><b>Which strategies trade</b></label><div class="radio">${radio('auto', 'Auto (recommended) — for each chart, its own best strategies with tuned settings, only if they passed the test')}${radio('all', 'All strategies (collect data)')}${radio('custom', 'Custom (table below)')}</div>
      <label for="sDaily"><b>Daily loss limit</b></label><div><input type="number" id="sDaily" min="1" max="50" step="1" value="${s.dailyLossPct}"> % — stop opening trades for the day after losing this much</div>
      <label for="sMax"><b>Max trades per day</b></label><div><input type="number" id="sMax" min="1" max="50" step="1" value="${s.maxTradesPerDay}"></div>
      <label for="sHold"><b>Time limit per trade</b></label><div><input type="number" id="sHold" min="0" max="1440" step="15" value="${s.maxHoldMin || 0}"> minutes (0 = no limit, run until TP or SL)</div>
      <div class="help">Trades still open at 16:55 New York (end of the trading day) are always closed, so nothing is held overnight.</div>
      <label for="sNews"><b>News filter</b></label><div><label><input type="checkbox" id="sNews" ${s.newsFilter !== false ? 'checked' : ''}> No new trades from 30 min before to 15 min after big US / euro news</label></div>
    </div>
    <h3>Custom selection</h3>
    <div class="table-wrap"><table class="matrix"><tr><th>Strategy</th>${SL.SYMBOLS.map((x) => `<th>${label(x)}</th>`).join('')}</tr>
      ${SL.STRATEGIES.map((g) => `<tr><td>${g.name}</td>${SL.SYMBOLS.map((x) => g.symbols.includes(x) ? `<td><input type="checkbox" data-k="${x}:${g.id}" ${custom[x + ':' + g.id] ? 'checked' : ''}></td>` : '<td class="muted">—</td>').join('')}</tr>`).join('')}
    </table></div>
    <p style="margin-top:14px"><button class="btn" id="sSave">Save settings</button> <span class="muted small" id="sMsg"></span></p>
    <h3>Danger zone</h3>
    <p><button class="btn danger" id="sReset">Reset demo account to $100</button> <span class="muted small">Deletes all demo trades and starts again.</span></p>`;
    $('sSave').onclick = () => {
      const c = {};
      document.querySelectorAll('#settingsBody input[data-k]').forEach((el) => { c[el.dataset.k] = el.checked; });
      const num = (id, a, b, d) => { const v = parseFloat($(id).value); return isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
      onSave({
        riskPct: num('sRisk', 0.25, 3, 1), dailyLossPct: num('sDaily', 1, 50, 5), maxTradesPerDay: Math.round(num('sMax', 1, 50, 12)),
        maxHoldMin: Math.round(num('sHold', 0, 1440, 0)), newsFilter: $('sNews').checked,
        mode: (document.querySelector('input[name=mode]:checked') || {}).value || 'auto', custom: c,
      });
      $('sMsg').textContent = 'Saved.';
    };
    $('sReset').onclick = () => { if (confirm('Reset the demo account to $100 and delete all demo trades?')) onReset(); };
  };

  // ---------- charts (TradingView Lightweight Charts) ----------
  const shift = (t) => t - new Date(t * 1000).getTimezoneOffset() * 60; // show local time on the axis
  const chartOpts = () => ({
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8a94a6', fontSize: 11 },
    grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
    rightPriceScale: { borderColor: '#2a3546' },
    timeScale: { borderColor: '#2a3546', timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
  });

  ui.chart = {
    c: null, s: null, lines: [], times: new Set(), sym: null, tf: null,
    init(el) {
      if (!window.LightweightCharts) { el.innerHTML = '<div class="empty">Chart library could not load (no internet?). Trading still works.</div>'; return; }
      this.c = LightweightCharts.createChart(el, chartOpts());
      this.s = this.c.addCandlestickSeries({ upColor: '#22c55e', downColor: '#f05252', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#f05252' });
    },
    setData(sym, tf, bars) {
      if (!this.c) return;
      const d = SL.INSTRUMENTS[sym].digits;
      this.s.applyOptions({ priceFormat: { type: 'price', precision: d, minMove: Math.pow(10, -d) } });
      const changed = this.sym !== sym || this.tf !== tf;
      this.sym = sym; this.tf = tf;
      this.times = new Set(bars.map((b) => shift(b.t)));
      this.s.setData(bars.map((b) => ({ time: shift(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
      if (changed) this.c.timeScale().fitContent();
    },
    update(bar) {
      if (!this.c || !bar) return;
      const t = shift(bar.t);
      this.times.add(t);
      try { this.s.update({ time: t, open: bar.o, high: bar.h, low: bar.l, close: bar.c }); } catch (e) { /* older bar */ }
    },
    setTrades(closed, open) {
      if (!this.c) return;
      const sec = this.tf === '1m' ? 60 : 300, sym = this.sym;
      const snap = (t) => shift(Math.floor(t / sec) * sec);
      const m = [];
      for (const t of closed.concat(open)) {
        if (t.sym !== sym) continue;
        const a = snap(t.openT);
        if (this.times.has(a)) m.push({ time: a, position: t.side > 0 ? 'belowBar' : 'aboveBar', color: '#4c8dff', shape: t.side > 0 ? 'arrowUp' : 'arrowDown', text: `#${t.id}` });
        if (t.closeT) {
          const b = snap(t.closeT);
          if (this.times.has(b)) m.push({ time: b, position: t.side > 0 ? 'aboveBar' : 'belowBar', color: t.pnl > 0 ? '#22c55e' : '#f05252', shape: 'circle', text: money(t.pnl) });
        }
      }
      m.sort((x, y) => x.time - y.time);
      this.s.setMarkers(m);
      for (const l of this.lines) this.s.removePriceLine(l);
      this.lines = [];
      for (const p of open) {
        if (p.sym !== sym) continue;
        this.lines.push(this.s.createPriceLine({ price: p.entry, color: '#4c8dff', lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: `#${p.id} entry` }));
        this.lines.push(this.s.createPriceLine({ price: p.sl, color: '#f05252', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'SL' }));
        this.lines.push(this.s.createPriceLine({ price: p.tp, color: '#22c55e', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'TP' }));
      }
    },
  };

  ui.equity = {
    c: null, s: null,
    render(el, st) {
      if (!window.LightweightCharts) return;
      if (!this.c) { this.c = LightweightCharts.createChart(el, chartOpts()); this.s = this.c.addAreaSeries({ lineColor: '#4c8dff', topColor: 'rgba(76,141,255,.25)', bottomColor: 'rgba(76,141,255,0)', lineWidth: 2 }); }
      let last = 0;
      const t0 = Math.min(st.createdAt, st.closed.length ? st.closed[0].openT : st.createdAt);
      const pts = [{ time: shift(t0), value: st.startBalance }];
      last = pts[0].time;
      for (const t of st.closed) { let time = shift(t.closeT); if (time <= last) time = last + 1; last = time; pts.push({ time, value: +t.balanceAfter.toFixed(2) }); }
      this.s.setData(pts);
      this.c.timeScale().fitContent();
    },
  };
})(window.SL = window.SL || {});
