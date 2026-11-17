// DIPLINE — a long-only cbBTC dip-buying bot for btc-race-24h-20261117-0603.
//
// The idea, in one sentence: Bitcoin's 1-minute noise is ~6 bps but its
// multi-hour swings are 100-200 bps, and a full round trip costs ~26 bps, so
// this bot does almost nothing — it waits for a real dip, buys it whole, and
// gets out on a fixed 2:1 take-profit / stop-loss.
//
// What the dev window (1,440 frozen 1-minute bars) taught us:
//   - Every fast strategy loses: EMA(8/21) -106 USDC on 68 trades, ADX -33 on
//     26, RSI/Bollinger -24 on 11. The window is range-bound and every extra
//     trade just pays the ~26 bps round trip.
//   - Only 1-trade strategies made money: buy-and-hold +1.07, 24-bar momentum
//     +2.45. The money sits in the few multi-hour swings, not in the noise.
//   - A deep dip is the entry that works: buying 150 bps below the trailing
//     6-hour high, exiting at +150 bps or -75 bps, made +27.46 USDC on 5
//     trades (max drawdown 0.8%). It also won on the time-reversed window
//     (+8.71) and on 4-hour block-bootstrap resamples (median +13.09 over
//     150 windows), while wider take-profits (200/100) failed the reversed
//     window outright (-13.12). The 2:1 ratio with a tight stop is what
//     survives unfamiliar paths; the exact numbers are a plateau, not a
//     spike — neighbouring settings (120-150 bps dip, 120-150 bps TP,
//     60-75 bps SL) all clear the dev gate too.
//   - So: one rule, few trades, full size, fixed exits. No trend filter
//     (tested: it kills the good trades, dev +8.54 and reversed -3.55),
//     no stop cooldown (tested: worse on reversed and bootstrap).
//
// Rules (all comparisons in exact bigint arithmetic on raw prices, so two
// runs on the same bars give byte-identical orders):
//   - Track the trailing 360-bar high of CBBTC closes (6 hours).
//   - BUY (full cash, capped by the weight cap) when the close is at least
//     150 bps below that high: close * 10000 <= high * 9850.
//   - SELL the whole position when the close is 150 bps above the entry
//     close (close * 10000 >= entry * 10150) or 75 bps below it
//     (close * 10000 <= entry * 9925).
//   - LATE BUY: at batch 1200, if no buy has ever filled, buy full cash
//     anyway (same exits). This only insures the guardrail: on a race day
//     with no 150 bps pullback the bot would otherwise end with 0 trades
//     and no prize. It never fired on the dev window.
//   - One open position, long only, max 100 bps slippage per order.
//
// The bot speaks agent-fun/bars-replay/v1 through the kit's shim: one JSON
// line per batch, one reply per batch echoing its seq. It reads no clock,
// no environment, no randomness — the bars alone decide everything.

import { runBars, type BuyInput, type BarsState, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** The trailing-high window: 360 one-minute bars = 6 hours. */
const LOOKBACK_BARS = 360;
/** Buy when the close sits this far below the trailing high, in bps. */
const DIP_BPS = 150n;
/** Exit up / down from the entry close, in bps (2:1 reward-to-risk). */
const TAKE_PROFIT_BPS = 150n;
const STOP_LOSS_BPS = 75n;
/** If no buy has ever filled by this batch, buy anyway (guardrail insurance). */
const LATE_BUY_BAR = 1200;
/** Per-order slippage cap, in bps. */
const MAX_SLIPPAGE_BPS = 100;
/** Basis points per unit: 10_000 bps = 100%. */
const BPS_DENOM = 10000n;

/** Every CBBTC close seen so far, raw price units (price_scale 5). */
const closes: bigint[] = [];
/** The close the current position was entered at, or null while flat. */
let entryClose: bigint | null = null;
/** Buys that actually filled (counted from the batches' fills). */
let filledBuys = 0;

/** The highest close of the last LOOKBACK_BARS + 1 bars, or null before then. */
function trailingHigh(): bigint | null {
  if (closes.length <= LOOKBACK_BARS) return null;
  let high = closes[closes.length - 1]!;
  for (let i = closes.length - 2; i >= closes.length - LOOKBACK_BARS - 1; i--) {
    if (closes[i]! > high) high = closes[i]!;
  }
  return high;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') filledBuys++;
    }
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    closes.push(BigInt(bar.c));
    if (state.warmingUp) return [];

    const close = BigInt(bar.c);
    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      if (entryClose === null) entryClose = close;
      if (close * BPS_DENOM >= entryClose * (BPS_DENOM + TAKE_PROFIT_BPS)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      if (close * BPS_DENOM <= entryClose * (BPS_DENOM - STOP_LOSS_BPS)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    entryClose = null;
    const high = trailingHigh();
    let buy = false;
    if (high !== null && close * BPS_DENOM <= high * (BPS_DENOM - DIP_BPS)) buy = true;
    if (!buy && batch.seq === LATE_BUY_BAR && filledBuys === 0) buy = true;
    if (!buy) return [];

    let size = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (room < size) size = room;
    if (size === 0n || size < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entryClose = close;
    const orders: OrderInput[] = [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    return orders;
  },
});
