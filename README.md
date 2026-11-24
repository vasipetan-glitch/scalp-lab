# Scalp Lab — demo trading (paper money only)

A personal dashboard that **automatically takes simulated short-term trades** on **EUR/USD, XAU/USD and
NAS100**, starting with **$100 of virtual money**, and reports every trade in real time.
There is no broker connection and no real money anywhere.

## Start it (PC version)

1. Double-click **`start.bat`**.
2. A black window opens (the small local server) and your browser opens **http://localhost:4870**.
3. Keep **both** open while you want the demo to trade. To stop: close the black window.

Nothing needs to be installed — it uses Windows PowerShell, which every Windows PC has.
If you close the app and open it again later, it **replays the market time you missed** (up to 6 days),
so the demo record stays complete. Those trades are marked with ⏱.
To keep it running while the PC is off, use the cloud version (below).

## What it does

- Downloads 1-minute candles (free Yahoo Finance data) and checks the strategies on every 5-minute candle.
- When a strategy gives a signal it opens a trade with an automatic **entry, stop loss (SL),
  take profit (TP) and risk/reward (RRR)**.
- **Risk per trade: 1% of the balance** ($1 on $100). The size is calculated from the SL distance.
- **Trades run until TP or SL** — no time limit (you can set one in Settings). Anything still open at
  **16:55 New York** (end of the trading day) is closed, so nothing is held overnight or over the weekend.
- **News filter:** no new trades from 30 min before to 15 min after high-impact US news (and euro news for
  EUR/USD), taken from the free Forex Factory calendar. The calendar only gives the current week, so the
  filter protects live trading; the app saves each week's events so future backtests can use them too.
- Every trade pays a realistic **spread** and needs **margin** (EU retail leverage 1:30 FX, 1:20 gold/index).
- Safety rules: one trade per market at a time, 10-minute pause after a trade, no new trades
  15:55–18:15 New York time or on Friday evening, daily loss limit 5%, max 12 trades a day.

## Strategies and the backtest

Every chart is treated **on its own**. For each chart, each of the 8 strategies is tried in several settings
versions (take-profit distance, a **break-even stop** that moves the stop to +0.1R after +1R, opening-range
length, skipping the quiet midday, …) on the last 2–3 months of 5-minute candles, spreads included:

1. **Training** (first 2/3 of the history): among the versions that made money, the one with the **highest win
   rate** that still keeps at least 85% of the best profit is chosen.
2. **Unseen test** (last 1/3): that version must also make money on data it was not tuned on.
3. Overall it needs at least 15 trades and must be profitable after costs.

Only strategies that pass are used, **only on the chart where they passed**, at most the best 2 per chart.
The test re-runs every time the app starts (the cloud runner every 6 hours), so the picks can change.

Strategies: NY Opening Range Breakout · London Breakout (Asian range) · Intraday Momentum (noise area, all day)
· Liquidity Sweep Reversal (all day) · Volatility Squeeze Breakout (all day) · Intraday Momentum (last 30 min)
· Trend Pullback (EMA 20/50/200) · Bollinger Mean Reversion. Descriptions are in the Strategy Lab tab.

Per-chart picks on 24 Nov 2026 (129 backtests; the current picks are always in the Strategy Lab tab):

| Chart | Strategies (tuned settings) |
|---|---|
| EUR/USD | London Breakout (RR 2 · BE) + Intraday Momentum – noise area (RR 3 · BE) |
| XAU/USD | London Breakout (RR 1.5) + NY Opening Range Breakout (15-min range · RR 3 · BE) |
| NAS100 | NY Opening Range Breakout (15-min range · RR 3 · BE) + Trend Pullback (RR 3 · BE) |

Same data, old way vs new way (break-even versions + win-rate-aware choice):

| | Old way | New way |
|---|---|---|
| Win rate | 39.5% | **51.6%** |
| $100 becomes | $147.51 | **$164.86** |
| Profit factor | 1.23 | **1.54** |
| Max drawdown | 15.2% | **12.8%** |
| Unseen part only | 39.5% wins, PF 1.29 | **51.7% wins, PF 1.63** |

Because only strategies that also did well on the unseen part were kept, even that part is a bit flattering —
the live demo is the real test.

### Modes (Settings → "Which strategies trade")

- **Auto** *(selected, recommended)* — the per-chart picks above, each with its tuned settings.
- **All strategies** — everything everywhere (lost money in the test).
- **Custom** — tick exactly which strategy trades on which chart (each uses its best settings for that chart).

Backtests are always more optimistic than real trading, and these samples are small. The live demo is the real test.

## Reports

- **Dashboard**: balance, equity, wins/losses, win rate, profit factor, drawdown, open trades with live P&L,
  live activity feed, trade history (with Entry, SL, TP, RRR, lots, exit, P&L, R), and a full Report tab.
  Charts show entries (arrows), exits (dots) and the SL/TP lines of open trades.
- **Files** (PC version, updated after every closed trade): `data\reports\report-YYYY-MM-DD.md` and
  `data\reports\trades.csv` (opens in Excel).
- **Alerts**: click "🔕 Alerts off" in the top right to get a sound + desktop notification for every trade.

## Cloud version (runs 24/7 on GitHub, even when your PC is off)

- `.github/workflows/trade.yml` makes GitHub run `runner/run.mjs` about every 10 minutes. It uses the exact
  same engine files as the PC (`public/js`), replays every finished 1-minute candle since the last run,
  saves the account in `cloud/state.json` and publishes the dashboard with GitHub Pages.
- Dashboard: `https://<your-username>.github.io/<repo-name>/` — works on your phone, read-only, refreshes
  every minute. Trades show up about 10–20 minutes after they happen; the results are the same as on the PC.
  The phone doesn't need to be on: everything runs on GitHub.
- Settings: edit `cloud/settings.json` on GitHub (`mode`: auto / all / custom, `riskPct`,
  `dailyLossPct`, `maxTradesPerDay`, `maxHoldMin` (0 = no limit), `newsFilter`, `paused`).
  To start again at $100, delete `cloud/state.json`.
- Phone alerts (optional): install the free **ntfy** app, subscribe to a secret topic name, and save the same
  name on GitHub as a repository secret called `NTFY_TOPIC` (Settings → Secrets and variables → Actions).
- The PC account (`data\`) and the cloud account (`cloud/`) are separate.
- GitHub can start runs a few minutes late, and it pauses schedules in public repositories after 60 days
  without activity (it emails you first; one click turns it back on).

## Honest notes

- This is a simulation, **not financial advice**. Backtests are usually better than real results.
- Gold and NAS100 use futures prices (GC=F, NQ=F) as stand-ins for the broker CFD prices: same moves,
  slightly different price level, possibly a few minutes delayed. EUR/USD is spot.
- With $100 and 1% risk, gold and NAS100 positions are smaller than most brokers' minimum lot (marked ⚠).
- Most retail CFD accounts lose money (74–89% per ESMA). See the **Research** tab for sources.

## Files

- `start.bat` — starts the PC version
- `server.ps1` — local server (localhost only): serves the page, fetches Yahoo data and the news calendar, saves the account
- `public\` — the dashboard and the trading engine (JavaScript)
- `data\state.json` — the PC demo account (delete it, or use Settings → Reset, to start again at $100)
- `runner\run.mjs`, `.github\workflows\trade.yml`, `cloud\` — the cloud version (see above)
