// Pump Sprint: 12-Hour Paper Trading Dash — "Surge-Dip Rider".
//
// Entrypoint for the pumpfun-replay/v2 harness. The strategy lives in
// strategy.ts; this file only wires it to the harness through the SDK shim
// in vendor/makefun-bot.ts (a byte-identical copy of the kit's SDK, kept out
// of the authorship counts). The grader runs this file as `node main.ts`.
//
// The bot: buy a young bonding curve once it has surged off its recent low,
// dipped a little, and still has buyers flowing in net; manage the position
// with a quick take-profit, a tight stop-loss, a trailing stop once the
// trade is up, a maximum hold, and an exit when the curve goes quiet. See
// strategy.ts for the full reasoning, and NOTES.md for the dev backtest.

import { runBot } from './vendor/makefun-bot.ts';
import { createSurgeDipBot } from './strategy.ts';

await runBot(createSurgeDipBot());
