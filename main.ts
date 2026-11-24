// Pump.fun Paper Sprint — flow + accumulation basket bot (agent-fun/replay/v2).
//
// What the dev-window data actually shows (and what v1/v2 got wrong):
//   * Every coin spikes in its creation slot and mostly decays after it, so
//     chasing a price rise after the fact buys the top (v1: 5 trades, v2
//     momentum: -3.07 SOL). The 2-slot fill latency eats the first +18% of
//     any move, so entries must come from FLOW, not from price alone.
//   * Two entry shapes survive on the dev window near breakeven:
//       A. Flow momentum: a mature coin (250+ slots old) whose last-30-slot
//          tape shows accelerating net SOL inflow from several distinct
//          buyers, price up a little and sitting near its window high.
//       B. Accumulation: many buys and solid net inflow over 60 slots while
//          the price is still flat (buyers stacking in before the move).
//   * After either entry the move is short-lived (~100 slots), so exits are
//     fast: a -15% stop, a ladder (half at +30%, rest at +80%), a 20%
//     trailing stop once up 10%, and a 1500-slot max hold. Sells go out at
//     10000 bps slippage so they always execute; buys at 1500 bps so they
//     still land while the price is moving.
//   * Small fixed size (0.04 SOL), one round trip per mint, at most 5 open:
//     losers stay small and the book stays diversified across dozens of
//     coins, comfortably above the 20-coin guardrail.
//
// Deterministic: no clock, no environment, no Math.random. All decisions come
// from the harness messages. stdout carries replies only; diagnostics go to
// stderr.
//
// v3: flow + accumulation entries, fast exits, loose slippage. Replaces the
// pure price-momentum entry of v2 (which lost -3.07 SOL on the dev window).
//
// v4: sells are never duplicated while one is in flight, never retried when
// the curve cannot pay them (payout over real reserves) or when they are
// dust (proceeds under the tx fee) — v3 sent ~60k such rejected sells.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---- tunables (lamports; 1 SOL = 1_000_000_000) ---------------------------
const BUY_SIZE = 40_000_000n; // 0.04 SOL per entry
const MIN_BUY = 20_000_000n; // skip a coin when the size cap allows less
const BUY_SLIP_BPS = 1500; // 15%: entries must land while the price moves
const SELL_SLIP_BPS = 10_000; // exits always execute, whatever the price
const STOP_BPS = -1_500; // -15%: sell everything
const TP1_BPS = 3_000; // +30%: sell half
const TP2_BPS = 8_000; // +80%: sell the rest
const TRAIL_ARM_BPS = 1_000; // trailing stop arms once up +10%
const TRAIL_DROP_BPS = 2_000; // ... then sell on a 20% fall from the peak
const MAX_HOLD_SLOTS = 1_500; // ~10 min, then exit and recycle the slot
const MAX_OPEN = 5;

// Flow-momentum entry (signal A).
const FLOW_WINDOW = 30;
const FLOW_MIN_AGE = 250;
const FLOW_MIN_NET_SOL = 1;
const FLOW_MIN_BUYS = 3;
const FLOW_MIN_BUYERS = 5;
const FLOW_MIN_RISE_BPS = 500; // +5% over the window
const FLOW_MAX_RISE_BPS = 15_000; // +150%
const FLOW_NEAR_HIGH_BPS = 9_500; // price >= 95% of the window high
const FLOW_MIN_RQ_SOL = 2;
const FLOW_MAX_RQ_SOL = 60;

// Accumulation entry (signal B).
const ACC_WINDOW = 60;
const ACC_MIN_AGE = 100;
const ACC_MIN_BUYS = 8;
const ACC_MIN_BUYERS = 5;
const ACC_MIN_NET_SOL = 2;
const ACC_MAX_RISE_BPS = 1_000; // price still flat: <= +10% over the window
const ACC_MIN_RQ_SOL = 1;
const ACC_MAX_RQ_SOL = 60;

const LAMPORTS = 1_000_000_000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number; // SOL (float, for flow sums only)
  user: string;
  price: number;
}

interface Coin {
  createdSlot: number | null;
  firstPrice: number;
  trades: TapeTrade[]; // pruned to the recent window
  entered: boolean;
  exited: boolean;
}

interface Position {
  entryPrice: number; // average cost basis (SOL per token, from the account)
  peakPrice: number;
  entrySlot: number;
  tp1Done: boolean;
}

const coins = new Map<string, Coin>();
const positions = new Map<string, Position>();
// Mints with a full sell already sent and not yet landed in the account:
// never re-add them to `positions` and never send a second sell for them.
const exiting = new Set<string>();

function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

/** Relative move in basis points: (now - ref) / ref * 10000. */
function moveBps(now: number, ref: number): number {
  if (ref <= 0 || now <= 0) return 0;
  return Math.round(((now - ref) / ref) * 10_000);
}

function tapeOf(mint: string, slot: number, firstPrice: number): Coin {
  let c = coins.get(mint);
  if (!c) {
    c = { createdSlot: null, firstPrice, trades: [], entered: false, exited: false };
    coins.set(mint, c);
  }
  return c;
}

/**
 * Flow-momentum signal: accelerating net inflow from several distinct buyers
 * over a short window, price up a little and near its window high.
 */
function flowSignal(c: Coin, now: number, rqSol: number): boolean {
  if (rqSol < FLOW_MIN_RQ_SOL || rqSol > FLOW_MAX_RQ_SOL) return false;
  if (c.createdSlot === null || now - c.createdSlot < FLOW_MIN_AGE) return false;
  const from = now - FLOW_WINDOW;
  const mid = now - FLOW_WINDOW / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  const buyers = new Set<string>();
  for (const tr of c.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.add(tr.user);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
  }
  if (buys < FLOW_MIN_BUYS || buyers.size < FLOW_MIN_BUYERS) return false;
  if (buySol - sellSol < FLOW_MIN_NET_SOL) return false;
  if (startPrice <= 0) return false;
  const last = c.trades.length > 0 ? c.trades[c.trades.length - 1]!.price : 0;
  const up = moveBps(last, startPrice);
  if (up < FLOW_MIN_RISE_BPS || up > FLOW_MAX_RISE_BPS) return false;
  if (last < (high * FLOW_NEAR_HIGH_BPS) / 10_000) return false;
  if (netNew <= 0 || netNew < netOld) return false;
  return true;
}

/**
 * Accumulation signal: heavy buying and net inflow over a longer window while
 * the price has barely moved — buyers stacking in before the move.
 */
function accumSignal(c: Coin, now: number, rqSol: number): boolean {
  if (rqSol < ACC_MIN_RQ_SOL || rqSol > ACC_MAX_RQ_SOL) return false;
  if (c.createdSlot === null || now - c.createdSlot < ACC_MIN_AGE) return false;
  const from = now - ACC_WINDOW;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let startPrice = -1;
  const buyers = new Set<string>();
  for (const tr of c.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.add(tr.user);
    } else {
      sellSol += tr.sol;
    }
  }
  if (buys < ACC_MIN_BUYS || buyers.size < ACC_MIN_BUYERS) return false;
  if (buySol - sellSol < ACC_MIN_NET_SOL) return false;
  if (startPrice <= 0) return false;
  const last = c.trades.length > 0 ? c.trades[c.trades.length - 1]!.price : 0;
  if (moveBps(last, startPrice) > ACC_MAX_RISE_BPS) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const maxOpen = Math.min(state.hello.caps.max_open_positions, MAX_OPEN);
    const touched = new Set<string>();
    const keepFrom = batch.slot - Math.max(FLOW_WINDOW, ACC_WINDOW) - 5;

    // --- fold this batch's events into per-coin tapes ----------------------
    for (const e of batch.events) {
      if (e.event === 'CompleteEvent') {
        const c = coins.get(e.mint);
        if (c) c.exited = true;
        positions.delete(e.mint);
        continue;
      }
      const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      if (p <= 0) continue;
      touched.add(e.mint);
      const c = tapeOf(e.mint, batch.slot, p);
      if (c.createdSlot === null && e.event === 'CreateEvent') c.createdSlot = e.slot;
      if (c.createdSlot === null) c.createdSlot = batch.slot;
      if (e.event === 'TradeEvent') {
        c.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAMPORTS,
          user: e.user,
          price: p,
        });
      }
    }
    // Prune old tape entries on touched coins only (keeps the scan cheap).
    for (const mint of touched) {
      const c = coins.get(mint)!;
      let cut = 0;
      while (cut < c.trades.length && c.trades[cut]!.slot <= keepFrom) cut++;
      if (cut > 0) c.trades.splice(0, cut);
    }

    // --- sync held positions from the account (fills land ~2 slots after
    // --- the buy). Entry price = average cost basis, so a pyramid buy
    // --- would correctly re-base the take-profit / stop levels. -----------
    for (const [mint, holding] of state.positions) {
      if (holding.token_amount === 0n) continue;
      if (exiting.has(mint)) continue; // a full sell is already in flight
      const avgCost = Number(holding.cost_lamports) / Number(holding.token_amount);
      const curve = state.curves.get(mint);
      const now = curve ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
      let pos = positions.get(mint);
      if (!pos) {
        positions.set(mint, {
          entryPrice: avgCost,
          peakPrice: now > 0 ? now : avgCost,
          entrySlot: batch.slot,
          tp1Done: false,
        });
      } else {
        pos.entryPrice = avgCost;
        if (now > pos.peakPrice) pos.peakPrice = now;
      }
    }
    // Positions the account no longer holds (flattened/completed by the
    // harness) are done; drop their records so the mint is never re-entered.
    for (const mint of [...positions.keys()]) {
      if (!state.positions.has(mint)) {
        positions.delete(mint);
        const c = coins.get(mint);
        if (c) c.exited = true;
      }
    }
    for (const mint of [...exiting]) {
      if (!state.positions.has(mint)) exiting.delete(mint);
    }

    // --- exits first: sells take priority over new buys -------------------
    // A sell already in flight for a mint is never duplicated.
    const sellPending = new Set<string>();
    for (const po of state.pending.values()) {
      if (po.order.side === 'sell') sellPending.add(po.order.mint);
    }
    for (const [mint, pos] of positions) {
      const holding = state.positions.get(mint);
      if (!holding || holding.token_amount === 0n) continue;
      if (sellPending.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      if (price > pos.peakPrice) pos.peakPrice = price;

      const move = moveBps(price, pos.entryPrice);
      const fromPeak = moveBps(price, pos.peakPrice);
      const age = batch.slot - pos.entrySlot;
      let sell: bigint | null = null;

      if (move <= STOP_BPS || age >= MAX_HOLD_SLOTS) {
        sell = holding.token_amount; // stop-loss or max hold: out completely
      } else if (!pos.tp1Done && move >= TP1_BPS) {
        sell = holding.token_amount / 2n; // ladder: bank half at +30%
        pos.tp1Done = true;
      } else if (pos.tp1Done && move >= TP2_BPS) {
        sell = holding.token_amount; // rest at +80%
      } else if (move >= TRAIL_ARM_BPS && fromPeak <= -TRAIL_DROP_BPS) {
        sell = holding.token_amount; // gave back 20% from the peak
      }
      if (sell !== null && sell > 0n) {
        // Skip a sell the curve cannot pay: the harness rejects a sell
        // whose payout exceeds the real quote reserves (a dead coin whose
        // real SOL drained away), and retrying it every batch spams the
        // run. Such a position is worth ~nothing; the end-of-run flatten
        // settles it. Also skip dust whose proceeds could not cover the
        // tx fee (the harness writes that off for free at the end).
        const gross = Number(sell) * price; // lamports, before curve fees
        const txFee = Number(state.txFeeLamports());
        const realQuote = Number(curve.real_quote_reserves);
        if (sell === holding.token_amount && (gross > realQuote || gross * 0.97 < 2 * txFee)) {
          positions.delete(mint);
          const c = coins.get(mint);
          if (c) c.exited = true;
          continue;
        }
        orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: SELL_SLIP_BPS });
        if (sell === holding.token_amount) {
          positions.delete(mint);
          exiting.add(mint);
          const c = coins.get(mint);
          if (c) c.exited = true;
        }
        if (orders.length >= maxOrders) return orders;
      }
    }

    // --- new entries: flow momentum or accumulation, on touched coins -----
    if (state.committedPositionCount() < maxOpen) {
      for (const mint of touched) {
        if (orders.length >= maxOrders) break;
        const c = coins.get(mint);
        if (!c || c.entered || c.exited) continue;
        if (state.positions.has(mint)) continue;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= maxOpen) break;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!flowSignal(c, batch.slot, rqSol) && !accumSignal(c, batch.slot, rqSol)) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY) continue;
        if (state.freeCashLamports() < BUY_SIZE + 500_000n) continue;
        const size = BUY_SIZE < cap ? BUY_SIZE : cap;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIP_BPS });
        c.entered = true;
      }
    }

    return orders;
  },

  onDone(state: BotState) {
    console.error(
      `done: batches=${state.seq} cash=${state.cash} open_positions=${state.positions.size} coins_seen=${coins.size}`,
    );
  },
});
