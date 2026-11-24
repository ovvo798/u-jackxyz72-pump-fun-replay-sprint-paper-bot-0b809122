# Pump.fun Replay Sprint — Paper Bot

Entry for the make.fun competition **"Pump.fun Replay Sprint — Paper Bot, Real Ranking"** (`u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`).

A paper-trading bot (`main.ts`, Node 22, zero dependencies) that trades 10 SOL of paper money on a replay of Solana pump.fun bonding-curve data. It speaks the `agent-fun/replay/v2` protocol through the kit's SDK shim (`vendor/makefun-bot.ts`). Paper trading only — no real funds ever move.

## Strategy: ride the young runners

Pump.fun coins mostly grind down; a few run 10x in their first minutes. The bot fishes for the runners and lets the trailing stop bank them:

- **Only young coins**: a coin qualifies for at most 2000 slots after creation.
- **Real money already in**: the curve must hold at least 2 SOL of real SOL reserves.
- **Sustained momentum**: enter when the price is up at least 80% over the last 200 slots — a climb, not a single-trade spike.
- **Ride with a wide trailing stop**: sell on a 25% pullback from the peak since entry, a 20% stop-loss from the entry price, or after 1000 slots — whichever comes first. No fixed take-profit: the rare big runner is where the money is.
- **Small, diversified size**: 0.2 SOL per coin (capped at 1% of the curve's real SOL reserves, the harness limit), at most 5 coins open at once.

Everything is a pure function of the harness state — no clock, no randomness, no environment, no network — so two runs produce byte-identical action logs.

## Files

- `main.ts` — the bot (entrypoint, run as `node main.ts`).
- `vendor/makefun-bot.ts` — the kit's protocol shim (copied from the competition kit's SDK).
- `LICENSE` — MIT.

## Local grading

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

Dev-window result: **+1.41 SOL net PnL** (55 distinct coins traded, max drawdown ~5%).
