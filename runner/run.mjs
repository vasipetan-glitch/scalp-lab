// Scalp Lab cloud runner (demo / paper money only).
// GitHub Actions starts this about every 10 minutes (.github/workflows/trade.yml). It runs the exact same
// engine files as the PC dashboard (public/js), saves the account in cloud/state.json and builds the
// website (site/) that GitHub Pages shows on your phone.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cloudDir = path.join(root, 'cloud');
const siteDir = path.join(root, 'site');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

globalThis.window = globalThis;
for (const f of ['data.js', 'indicators.js', 'strategies.js', 'engine.js', 'selection.js', 'cloud.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'public', 'js', f), 'utf8'), { filename: f });
}
const SL = globalThis.SL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// Yahoo Finance chart data (no key needed). Retries on both Yahoo hosts.
async function fetchBars(symbol, opts) {
  const q = new URLSearchParams({ interval: opts.interval });
  if (opts.period1) { q.set('period1', String(opts.period1)); q.set('period2', String(opts.period2)); }
  else q.set('range', opts.range);
  const sym = encodeURIComponent(SL.INSTRUMENTS[symbol].yahoo);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = attempt % 2 ? 'query2' : 'query1';
    try {
      const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?${q}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.ok) return SL.parseYahoo(await res.json(), opts.interval === '1m' ? 60 : 300);
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
    await sleep(1500 * (attempt + 1));
  }
  throw lastErr;
}

// This week's economic calendar (free Forex Factory feed) for the news filter
async function fetchNews() {
  const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Optional phone alerts through the free ntfy app (only if the NTFY_TOPIC secret is set)
async function notify(events, now) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  for (const e of events) {
    if ((e.type !== 'open' && e.type !== 'close') || now - e.t > 3 * 3600) continue; // no flood after outages
    const msg = SL.alertText(e);
    const tag = e.type === 'open' ? 'chart_with_upwards_trend' : e.trade.pnl > 0 ? 'white_check_mark' : 'x';
    try {
      await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', headers: { Title: msg.title, Tags: tag }, body: msg.body });
    } catch (err) { console.log('ntfy failed:', err.message); }
  }
}

const now = Math.floor(Date.now() / 1000);
const statePath = path.join(cloudDir, 'state.json');
const btPath = path.join(cloudDir, 'backtest.json');
const res = await SL.cloudStep({
  state: readJson(statePath), backtest: readJson(btPath),
  settings: readJson(path.join(cloudDir, 'settings.json')) || {}, fetchBars, fetchNews, now,
});
for (const line of res.logs) console.log(line);
console.log(`balance $${res.state.balance.toFixed(2)} | open ${res.state.open.length} | closed ${res.state.closed.length} | saved: ${res.changed}`);

fs.mkdirSync(cloudDir, { recursive: true });
if (res.changed) fs.writeFileSync(statePath, JSON.stringify(res.state));
if (res.btChanged) fs.writeFileSync(btPath, JSON.stringify(res.backtest));
await notify(res.events, now);

// Website for GitHub Pages: the dashboard files plus the latest data (read-only viewer mode)
fs.rmSync(siteDir, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), siteDir, { recursive: true });
fs.mkdirSync(path.join(siteDir, 'data'), { recursive: true });
fs.writeFileSync(path.join(siteDir, 'data', 'site.json'), JSON.stringify(res.site));
fs.writeFileSync(path.join(siteDir, '.nojekyll'), '');
