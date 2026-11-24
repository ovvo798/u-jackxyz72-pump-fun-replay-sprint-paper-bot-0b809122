// SPDX-License-Identifier: MIT
// Pump.fun Replay Sprint — paper bot.
//
// Strategy (written from scratch for this competition):
//   Ride the young runners. A coin only qualifies while it is young (at most
//   2000 slots after creation) and its bonding curve already holds real
//   money (at least 2 SOL of real SOL reserves). Enter when its price has
//   climbed at least 80% over the last 200 slots — a sustained climb, not a
//   single-trade spike — and ride it with a wide trailing stop: sell on a
//   25% pullback from the peak since entry, a 20% stop-loss from the entry
//   price, or after 1000 slots, whichever comes first. No take-profit: the
//   rare 10x runner is where the money is, and the trailing stop is what
//   banks it. Position size is 0.2 SOL per coin (capped at 1% of the curve's
//   real SOL reserves, the harness limit), at most 5 coins at once, so the
//   bot stays diversified across many coins and the worst case stays far
//   inside the 50% drawdown guardrail.
//
//   Everything is a pure function of the harness state: no clock, no
//   randomness, no environment, no network. The same dataset and the same
//   replies always give the same action log.

import { runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** SOL per entry, in lamports (0.2 SOL). */
const SIZE_LAMPORTS = 200_000_000n;
/** Minimum real SOL reserves a curve must hold to be buyable. */
const MIN_REAL_RESERVES_LAMPORTS = 2_000_000_000n;
/** Minimum buy that counts as a round trip for the guardrail (0.01 SOL). */
const MIN_BUY_LAMPORTS = 10_000_000n;
/** Momentum window, in slots. */
const MOMENTUM_WINDOW_SLOTS = 200;
/** Minimum price rise over the momentum window to enter (+80%). */
const MOMENTUM_MIN = 0.8;
/** A coin stops qualifying this many slots after creation. */
const MAX_AGE_SLOTS = 2000;
/** Stop-loss vs the entry price (-20%). */
const STOP_LOSS = 0.2;
/** Trailing stop vs the peak price since entry (-25%). */
const TRAILING_STOP = 0.25;
/** Time stop: sell after this many slots in a position. */
const MAX_HOLD_SLOTS = 1000;
/** Slippage allowance on every order, in bps (5%). */
const SLIPPAGE_BPS = 500;
/** The harness never lets more than this many positions stay open. */
const MAX_OPEN_POSITIONS = 5;

// ------------------------------------------------------------------ tracking

interface MintTrack {
  /** Slot of the CreateEvent (first-seen slot when the create was not delivered). */
  createdSlot: number;
  /** [slot, price] samples, one per slot that carried a trade, in slot order. */
  history: Array<[number, number]>;
  /** Its CompleteEvent arrived: untradable. */
  complete: boolean;
  /** Entry price (SOL per token) of the open position, 0 when flat. */
  entryPrice: number;
  /** Highest price seen since entry, SOL per token. */
  peakPrice: number;
  /** Slot the open position's buy filled on. */
  buySlot: number;
}

const tracks = new Map<string, MintTrack>();

function trackOf(mint: string, slot: number): MintTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = { createdSlot: slot, history: [], complete: false, entryPrice: 0, peakPrice: 0, buySlot: 0 };
    tracks.set(mint, t);
  }
  return t;
}

/** Current price of a curve in SOL per token, from its virtual reserves. */
function priceOf(state: BotState, mint: string): number | null {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

/** Latest recorded price at or before `slot`, or null when the coin is too young. */
function priceAtOrBefore(t: MintTrack, slot: number): number | null {
  const h = t.history;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i]![0] <= slot) return h[i]![1];
  }
  return null;
}

// ------------------------------------------------------------------ the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const touched = new Set<string>();

    // 1. Fold this batch's events into the per-mint tracks.
    for (const e of batch.events) {
      touched.add(e.mint);
      const t = trackOf(e.mint, e.slot);
      if (e.event === 'CreateEvent') {
        t.createdSlot = e.slot;
        const p = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        t.history.push([e.slot, p]);
      } else if (e.event === 'TradeEvent') {
        const p = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        const h = t.history;
        if (h.length > 0 && h[h.length - 1]![0] === e.slot) h[h.length - 1]![1] = p;
        else h.push([e.slot, p]);
      } else {
        t.complete = true;
      }
    }

    // 2. A filled buy sets the position's entry price, peak and buy slot.
    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.side !== 'buy') continue;
      const tokens = BigInt(f.token_amount);
      const paid = BigInt(f.quote_lamports);
      if (tokens === 0n || paid === 0n) continue;
      const t = trackOf(f.mint, f.slot);
      t.entryPrice = Number(paid) / Number(tokens);
      t.peakPrice = t.entryPrice;
      t.buySlot = f.slot;
    }

    // 3. Drop entry data for positions that are gone (sold, force-closed, written off).
    for (const [mint, t] of tracks) {
      if (t.entryPrice !== 0 && !state.positions.has(mint)) {
        t.entryPrice = 0;
        t.peakPrice = 0;
        t.buySlot = 0;
      }
    }

    const orders: OrderInput[] = [];
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }

    // 4. Exits: stop-loss, trailing stop, time stop. Full position, every time.
    for (const [mint, holding] of state.positions) {
      const t = tracks.get(mint);
      if (t === undefined || t.complete || t.entryPrice === 0) continue;
      if (pendingSell.has(mint)) continue;
      const px = priceOf(state, mint);
      if (px === null) continue;
      if (px > t.peakPrice) t.peakPrice = px;
      const ret = px / t.entryPrice - 1;
      const trail = px / t.peakPrice - 1;
      const sell =
        ret <= -STOP_LOSS ||
        (t.peakPrice > t.entryPrice && trail <= -TRAILING_STOP) ||
        slot - t.buySlot >= MAX_HOLD_SLOTS;
      if (sell) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
      }
    }

    // 5. Entries: young coins with real reserves and sustained momentum.
    const buysAlready = orders.filter((o) => o.side === 'buy').length;
    const openCount = state.committedPositionCount() + buysAlready;
    if (openCount < MAX_OPEN_POSITIONS) {
      for (const mint of touched) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= MAX_OPEN_POSITIONS) break;
        if (state.positions.has(mint)) continue;
        if ([...state.pending.values()].some((p) => p.order.mint === mint)) continue;
        const t = tracks.get(mint);
        if (t === undefined || t.complete) continue;
        if (slot - t.createdSlot > MAX_AGE_SLOTS) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.real_quote_reserves < MIN_REAL_RESERVES_LAMPORTS) continue;
        const px = priceOf(state, mint);
        if (px === null) continue;
        const ref = priceAtOrBefore(t, slot - MOMENTUM_WINDOW_SLOTS);
        if (ref === null || ref <= 0) continue;
        if (px / ref - 1 < MOMENTUM_MIN) continue;
        let size = SIZE_LAMPORTS;
        const cap = state.maxBuyLamports(mint);
        if (cap < size) size = cap;
        if (size < MIN_BUY_LAMPORTS) continue;
        if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
      }
    }

    return orders.slice(0, 16);
  },

  onDone(state: BotState, done): void {
    console.error(
      `done: batches=${state.seq + 1} cash=${state.cash} positions=${state.positions.size} reason=${done.reason}`,
    );
  },
});
