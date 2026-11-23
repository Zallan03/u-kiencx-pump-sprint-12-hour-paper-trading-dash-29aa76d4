// "Surge-Dip Rider" — strategy for the Pump Sprint paper-trading replay.
//
// A fresh-coin dip bot for agent-fun/replay/v2. It watches every new bonding
// curve, and only steps in after the curve has shown it can move: a fast
// surge off its recent low, then a small pullback while buyers are still
// flowing in net. It buys once per signal with a fixed stake, then manages
// the position with a take-profit, a stop-loss, a trailing stop once the
// trade is comfortably up, a maximum hold, and an exit when the curve goes
// quiet. Nothing here reads the clock, the environment or Math.random: every
// decision is a pure function of the hello message and the batches the
// harness has delivered so far, so the two grading runs agree.
//
// How a batch flows through this bot: the harness hands us one batch per slot
// that carried events. For that slot we first fold the batch's trades into
// each mint's tape, then we work the exits (positions we already hold), then
// the entries (fresh signals on mints that traded in this batch), and finally
// the guardrail probes, which keep the run above the 20-coin bar even on a
// slow stretch of the replay. Every order we return is one the harness will
// try to fill two slots later, so buys carry a modest slippage budget and
// sells carry a wide one: a sell refused for price movement is worse than a
// sell that fills a little lower.
//
// Fees: a buy or a sell pays 95 bps protocol + 30 bps creator on the curve,
// plus one 105,000-lamport transaction fee per order. A round trip therefore
// costs about 2.5% of the stake plus ~0.00021 SOL, so the take-profit has to
// sit well clear of that, and the stop-loss has to sit close enough that a
// dead coin cannot eat the winners. The exits are deliberately quick: on
// pump.fun a coin that has not moved within a few hundred slots is usually
// not going to.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000; // lamports in one SOL, as a plain number
const CURVE_FEE = 0.0125; // 95 bps protocol + 30 bps creator, charged on each side
const BPS = 10_000;

export interface Params {
  // Entry: a young curve that surged, dipped a little, and still has buyers.
  entryWindow: number; // slots of tape the entry signal looks at
  minBuys: number; // buy trades inside the window
  minBuyers: number; // distinct wallets buying inside the window
  minNetSol: number; // net SOL inflow (buys minus sells) inside the window
  minSurge: number; // window high at least this far above the window low
  minDip: number; // price now at least this far below the window high
  maxDip: number; // ...but no more than this far below it (a deep dip is a dump)
  minAboveLow: number; // ...and still at least this far above the window low
  minRqSol: number; // real SOL reserve at entry: not a dust curve ...
  maxRqSol: number; // ... and not one that already ran away
  maxAgeSlots: number; // only curves created within the last ~20 minutes
  maxEntriesPerMint: number; // at most this many separate entries on one mint
  cooldownSlots: number; // wait this long after an exit before re-entering
  // Sizing and exits.
  stakeSol: number; // SOL spent on each fresh entry
  minBuySol: number; // never send a buy smaller than this
  buySlipBps: number; // buys refuse a fill worse than this past decision
  sellSlipBps: number; // sells always fill: a refused sell is worse
  takeProfit: number; // sell when the position is worth cost * (1 + this)
  stopLoss: number; // sell when the position is worth cost * (1 - this)
  trailArm: number; // trailing stop arms once value reaches cost * (1 + this)
  trail: number; // ... then sells when value falls this far from its peak
  maxHoldSlots: number; // sell after this long held, whatever the price
  idleExitSlots: number; // sell when no trade touched the curve for this long
  // Guardrail pacing: the run must end with at least 20 coins holding a
  // round trip of 0.01 SOL or more. When our own fills or coins lag the
  // pace, open tiny probe round trips (buy a little, sell it as soon as it
  // lands) on the most liquid curve that traded in this batch.
  targetCoins: number;
  targetFills: number;
  paceSecs: number; // block time to reach the targets
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  entryWindow: 90,
  minBuys: 5,
  minBuyers: 7,
  minNetSol: 3.0,
  minSurge: 0.1,
  minDip: 0.04,
  maxDip: 0.15,
  minAboveLow: 0.04,
  minRqSol: 5.0,
  maxRqSol: 60,
  maxAgeSlots: 3000,
  maxEntriesPerMint: 2,
  cooldownSlots: 200,
  stakeSol: 0.5,
  minBuySol: 0.02,
  buySlipBps: 2000,
  sellSlipBps: 10_000,
  takeProfit: 1.5,
  stopLoss: 0.1,
  trailArm: 0.15,
  trail: 0.25,
  maxHoldSlots: 1500,
  idleExitSlots: 600,
  targetCoins: 30,
  targetFills: 120,
  paceSecs: 21_600,
  probeSol: 0.02,
  maxProbes: 2,
};

// ---------------------------------------------------------------- per-mint tape
interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number; // virtual SOL per token at this trade
}

interface MintTrack {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
  lastTradeSlot: number;
}

interface HeldPosition {
  openedSlot: number;
  peakValueSol: number;
  filled: boolean;
  exiting: boolean;
}

/** Price of one token in SOL from virtual reserves. */
function priceOf(vq: bigint, vt: bigint): number {
  const q = Number(vq);
  const t = Number(vt);
  if (t <= 0) return 0;
  return q / t;
}

/**
 * What a position is worth right now, in SOL, after the sell-side curve fee
 * and one transaction fee: the constant-product payout for selling every
 * token we hold, less 1.25%, less the tx fee.
 */
function positionValueSol(
  tokens: bigint,
  vq: bigint,
  vt: bigint,
  txFeeLamports: bigint,
): number {
  const n = Number(tokens);
  if (n <= 0) return 0;
  const gross = (n * Number(vq)) / (Number(vt) + n);
  return (gross / LAMPORTS) * (1 - CURVE_FEE) - Number(txFeeLamports) / LAMPORTS;
}

export function createSurgeDipBot(p: Params = DEFAULT_PARAMS): Bot {
  const tracks = new Map<Pubkey, MintTrack>();
  const held = new Map<Pubkey, HeldPosition>();
  const probes = new Map<Pubkey, boolean>(); // mint -> true once its probe is selling
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  /**
   * Net SOL our own fills moved into (+) or out of (-) each curve, in
   * lamports. The replay sizes buys against the curve's reserves AFTER our
   * own paper trades moved them, so a buy that follows a profitable sale
   * on the same mint faces a smaller cap than the chain reserves suggest.
   * We track the offset from our fills and size against the effective
   * reserve, so re-entries do not get refused for size over and over.
   */
  const netQuote = new Map<Pubkey, bigint>();

  const trackOf = (mint: Pubkey): MintTrack => {
    let t = tracks.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1e12, lastTradeSlot: -1e12 };
      tracks.set(mint, t);
    }
    return t;
  };

  /**
   * The entry signal: surge, shallow dip, and buyers still flowing in. Reads
   * only the tape inside entryWindow slots, so a curve that surged an hour
   * ago and has gone quiet cannot trigger it. The last trade in the window
   * must be a buy: we want live buy pressure at decision time, not the
   * echo of a pump that already ended.
   */
  const entrySignal = (t: MintTrack, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.createdSlot === null || now - t.createdSlot > p.maxAgeSlots) return false;
    const from = now - p.entryWindow;
    let buys = 0;
    let net = 0;
    let low = Infinity;
    let high = 0;
    let last = 0;
    let lastBuy = false;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (tr.buy) {
        buys++;
        buyers.add(tr.user);
        net += tr.sol;
      } else {
        net -= tr.sol;
      }
      if (tr.price < low) low = tr.price;
      if (tr.price > high) high = tr.price;
      last = tr.price;
      lastBuy = tr.buy;
    }
    if (buys < p.minBuys || buyers.size < p.minBuyers) return false;
    if (net < p.minNetSol) return false;
    if (!lastBuy) return false;
    if (low <= 0 || high <= 0 || last <= 0) return false;
    if (high / low - 1 < p.minSurge) return false; // no surge, no trade
    if (last > high * (1 - p.minDip)) return false; // has not dipped yet
    if (last < high * (1 - p.maxDip)) return false; // dipped too far: a dump
    if (last < low * (1 + p.minAboveLow)) return false; // dipped back to the low
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txFee = state.txFeeLamports();
      const txSol = Number(txFee) / LAMPORTS;
      const cap = state.hello.caps.max_orders_per_batch;
      const orders: OrderInput[] = [];

      // Count our own fills (harness closes carry client ids starting with '_').
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
          const delta = f.side === 'buy' ? BigInt(f.quote_lamports) : -BigInt(f.quote_lamports);
          netQuote.set(f.mint, (netQuote.get(f.mint) ?? 0n) + delta);
        }
      }

      // Fold this batch's events into the tapes.
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          trackOf(e.mint).createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = trackOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          });
          t.lastTradeSlot = e.slot;
          traded.add(e.mint);
        }
      }
      // Trim tapes to the lookback we actually read, so memory stays bounded.
      const keepFrom = now - Math.max(p.entryWindow, p.idleExitSlots) - 10;
      for (const mint of traded) {
        const t = tracks.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= keepFrom) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const pendingSell = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') return true;
        }
        return false;
      };

      // ---- exits first: take-profit, stop-loss, trailing stop, hold limit,
      // ---- and the quiet-curve exit. A position sells whole, once.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            if (h.filled) trackOf(mint).lastExitSlot = now;
            else trackOf(mint).entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = positionValueSol(
          pos.token_amount,
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          txFee,
        );
        if (value > h.peakValueSol) h.peakValueSol = value;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const t = trackOf(mint);
        let exit = h.exiting;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && h.peakValueSol >= cost * (1 + p.trailArm) && value <= h.peakValueSol * (1 - p.trail)) {
          exit = true;
        }
        if (!exit && now - h.openedSlot > p.maxHoldSlots) exit = true;
        if (!exit && now - t.lastTradeSlot > p.idleExitSlots) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingSell(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // ---- probe round trips: sell a probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
        if (!selling) probes.set(mint, true);
      }

      // ---- entries: one fixed-stake buy per fresh signal. Amounts are
      // ---- computed in integer lamports, with a safety margin under the
      // ---- harness's 1%-of-real-reserve size cap: a float round-trip can
      // ---- land one lamport over the cap and get the whole buy refused.
      let free = state.freeCashLamports();
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        const t = tracks.get(mint)!;
        if (t.entries >= p.maxEntriesPerMint) continue;
        if (now - t.lastExitSlot < p.cooldownSlots) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        // Size against the effective reserve: the chain reserve plus our
        // own net inflow when it is negative (a past sale shrank the cap);
        // a positive offset only raises the real cap, so we ignore it and
        // stay conservative. Shave 2% plus 1000 lamports off the cap so
        // fee rounding in our fill accounting cannot push a buy over it.
        const net = netQuote.get(mint) ?? 0n;
        const effRq = net < 0n ? curve.real_quote_reserves + net : curve.real_quote_reserves;
        let capLamports = (effRq * BigInt(state.hello.caps.max_order_bps_of_real_reserve)) / BigInt(BPS);
        capLamports -= capLamports / 50n + 1000n;
        if (capLamports < 0n) capLamports = 0n;
        let amount = BigInt(Math.floor(p.stakeSol * LAMPORTS));
        if (amount > capLamports) amount = capLamports;
        const affordable = free - txFee;
        if (amount > affordable) amount = affordable;
        if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + txFee;
        slotsLeft--;
        held.set(mint, { openedSlot: now, peakValueSol: 0, filled: false, exiting: false });
        t.entries++;
      }

      // ---- guardrail pacing: open a probe when fills or coins lag the pace.
      if (
        probes.size < p.maxProbes &&
        slotsLeft > 0 &&
        firstBlockTime !== null &&
        lastBlockTime !== null
      ) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          // The most liquid curve that traded in this batch and is free.
          let bestMint: Pubkey | null = null;
          let bestRq = 0;
          for (const mint of traded) {
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
            if (state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const rq = Number(curve.real_quote_reserves) / LAMPORTS;
            if (rq > bestRq) {
              bestRq = rq;
              bestMint = mint;
            }
          }
          if (bestMint !== null && bestRq >= p.probeSol * (BPS / state.hello.caps.max_order_bps_of_real_reserve) * 1.5) {
            const probeLamports = BigInt(Math.floor(p.probeSol * LAMPORTS));
            if (orders.length < cap && free >= probeLamports + 2n * txFee) {
              orders.push({
                side: 'buy',
                mint: bestMint,
                quote_lamports: probeLamports,
                max_slippage_bps: p.buySlipBps,
              });
              probes.set(bestMint, false);
              free -= probeLamports + txFee;
            }
          }
        }
      }

      return orders;
    },
  };
}
