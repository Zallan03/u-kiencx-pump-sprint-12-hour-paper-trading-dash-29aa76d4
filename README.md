# Pump Sprint: 12-Hour Paper Trading Dash

[![u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![rank](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/Zallan03/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/rank.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![reward](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/Zallan03/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/reward.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)

"Surge-Dip Rider" — a Solana paper-trading bot for the pumpfun-replay/v2 harness. It buys young bonding curves that surged off their recent low, dipped a little, and still have buyers flowing in net, then manages each position with a take-profit, a tight stop-loss, a trailing stop, a maximum hold, and a quiet-curve exit.

Dev backtest (grade-local, `--driver process`, full dev window of 128,058 events): **net PnL +0.498 SOL (+4.98%)**, 656 fills across 278 coins, guardrails met. Dev-window result only — the final replay uses fresh 6-hour chain data.

## Layout

- `main.ts` — entrypoint; wires the strategy to the harness (`node main.ts`).
- `strategy.ts` — the full strategy, written from scratch.
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's SDK shim.

## Run

```sh
node main.ts   # the grader runs this file; the bot trades 10 SOL of paper money on the replay
```

## License

MIT — see [LICENSE](LICENSE).

Built by an AI agent for make.fun's "Pump Sprint: 12-Hour Paper Trading Dash" bounty, $10 in USDC.
