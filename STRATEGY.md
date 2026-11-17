# STRATEGY.md — DIPLINE (btc-race-24h-20261117-0603)

## What the bot does

Long-only, one position, full size. It buys cbBTC/USDC only when the close is
at least 150 bps below the trailing 360-bar (6-hour) high, and sells the whole
position at +150 bps (take-profit) or -75 bps (stop-loss) from the entry close.
At batch 1200, if no buy has ever filled, it buys anyway — guardrail insurance
so a race day with no deep pullback still ends with at least 1 trade. All
comparisons are exact bigint arithmetic on raw prices: no clock, no randomness,
no environment reads — two runs on the same bars give byte-identical orders.

## Why this should generalize to the unseen race window

The dev window is range-bound with ~6.4 bps of 1-minute noise and a ~26 bps
round-trip cost, so any strategy that trades often just pays fees: EMA(8/21)
-106.21 USDC on 68 trades, ADX -32.66 on 26, RSI/Bollinger -24.25 on 11
(grade-local, --driver process). Only few-trade strategies made money
(buy-and-hold +1.07, 24-bar momentum +2.45). The money sits in the few
multi-hour swings (the dev day's big one: dip to $63,874, rally to $65,467).

The dip rule was chosen on evidence, not on one number:

| test | dip N360 d150 tp150 sl75 |
|---|---|
| dev window, full (grade-local target) | +27.46 USDC, 5 trades, max DD 0.96% |
| time-reversed dev window | +8.71 USDC, 6 trades |
| 4h block-bootstrap, 200 resampled windows | median +13.33, p10 -3.52, 39/200 ≤ 0 |
| drift stress (-15/-10/+10 bps per hour) | -27.8 / -5.7 / +12.1 |

Neighbouring settings form a plateau (dip 120-150 bps, TP 120-150, SL 60-75
all pass the dev gate), so the pick is not a magic number. Wider
take-profits (200/100) failed the reversed window (-13.12) and were dropped.
A trend filter (close above SMA360) and a 120-bar stop cooldown were both
tested and rejected — worse on dev, reversed, and bootstrap. The 2:1
reward-to-risk with a tight stop is what survives unfamiliar paths.

## Risks

- A strong down-trending race day (-15 bps/hour drift ≈ -3.6%/day) loses
  money: the bot keeps buying dips that keep dipping, each stopped at -75 bps.
  The stop caps each loss near -1% of equity; max drawdown on dev was 0.96%.
- A monotonic uptrend day with no 150 bps pullback triggers only the late
  buy at batch 1200 (last 4 hours) — small exposure, small expected gain.
- The dev window is one 24-hour sample; the bootstrap and reversed-window
  tests are the main defence against overfitting, and they are resamples of
  the same day, not new data. The edge is the 2:1 payoff on genuine
  multi-hour swings, not a fitted parameter.
