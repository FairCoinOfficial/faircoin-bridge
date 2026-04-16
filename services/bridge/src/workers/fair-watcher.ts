import { getAddress } from "viem";
import { config } from "../config.js";
import { alert } from "../lib/alert.js";
import { logger } from "../lib/logger.js";
import { Deposit, type DepositDoc } from "../models/deposit.js";
import { EventCursor } from "../models/event-cursor.js";
import { createMintQueue } from "../queues.js";
import { basePublic } from "../rpc/base.js";
import {
  getBlockAtHeight,
  getTipHeight,
  type BlockTx,
  type TxVout,
} from "../rpc/fair.js";
import { wfairAbi } from "../rpc/wfair-abi.js";
import { getKnownDepositAddressSet } from "../hd/derive.js";

const TICK_MS = 5000;
const INITIAL_BACKFILL_BLOCKS = 100;
const SATS_PER_FAIR = 100_000_000n;
const SATS_TO_WEI = 10_000_000_000n; // 1e10, to move 8-dec sats to 18-dec wei
const BPS_DENOM = 10_000n;
const DAY_MS = 24 * 60 * 60 * 1000;
// See base-watcher.ORPHAN_WITHDRAWAL_AGE_MS — same reasoning, mirrored on
// the deposit side: a CONFIRMED deposit older than this with no successful
// mint enqueue is treated as an orphan and re-pushed to the queue.
const ORPHAN_DEPOSIT_AGE_MS = 5 * 60 * 1000;

function voutAddress(vout: TxVout): string | undefined {
  if (vout.scriptPubKey.addresses && vout.scriptPubKey.addresses.length > 0) {
    return vout.scriptPubKey.addresses[0];
  }
  if (vout.scriptPubKey.address) return vout.scriptPubKey.address;
  return undefined;
}

function fairValueToSats(value: number): bigint {
  return BigInt(Math.round(value * 100_000_000));
}

function applyFee(amount: bigint, feeBps: number): bigint {
  return (amount * (BPS_DENOM - BigInt(feeBps))) / BPS_DENOM;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readWfairTotalSupply(): Promise<bigint> {
  return basePublic.readContract({
    address: config.WFAIR_CONTRACT_ADDRESS as `0x${string}`,
    abi: wfairAbi,
    functionName: "totalSupply",
  });
}

async function sumInFlightWei(): Promise<bigint> {
  const rows = await Deposit.find(
    { status: { $in: ["DETECTED", "CONFIRMED", "MINTING"] } },
    { amountWei: 1 },
  ).lean<Array<{ amountWei: string }>>();
  let total = 0n;
  for (const row of rows) {
    try {
      total += BigInt(row.amountWei);
    } catch {
      // malformed row — skip, don't crash the watcher
    }
  }
  return total;
}

async function sumDailyDepositSatsForAddress(
  baseAddress: string,
): Promise<bigint> {
  const since = new Date(Date.now() - DAY_MS);
  const rows = await Deposit.find(
    {
      baseAddress: baseAddress.toLowerCase(),
      createdAt: { $gte: since },
      status: { $in: ["CONFIRMED", "MINTING", "MINTED"] },
    },
    { amountSats: 1 },
  ).lean<Array<{ amountSats: string }>>();
  let total = 0n;
  for (const row of rows) {
    try {
      total += BigInt(row.amountSats);
    } catch {
      // skip malformed rows
    }
  }
  return total;
}

interface MatchedDeposit {
  /**
   * The original "intent" deposit at this address (status AWAITING or
   * DETECTED) if it still exists, otherwise null. When null we are looking
   * at a user re-using a deposit address after a prior mint has settled.
   */
  pending: DepositDoc | null;
  /** Earliest deposit at this address — source of truth for baseAddress + hdIndex. */
  origin: DepositDoc | null;
  fairAddress: string;
  amountSats: bigint;
}

async function matchVout(
  addressSet: Set<string>,
  _tx: BlockTx,
  vout: TxVout,
): Promise<MatchedDeposit | null> {
  const address = voutAddress(vout);
  if (!address) return null;
  if (!addressSet.has(address)) return null;
  // Find the still-open intent slot at this address, if any. There is at
  // most one because /intent allocates a fresh address each call.
  const pending = await Deposit.findOne({
    fairAddress: address,
    status: { $in: ["AWAITING", "DETECTED"] },
  }).lean<DepositDoc | null>();
  // For re-use: any prior deposit at this address gives us the canonical
  // baseAddress + hdIndex to inherit.
  const origin = pending
    ? pending
    : await Deposit.findOne({ fairAddress: address })
        .sort({ createdAt: 1 })
        .lean<DepositDoc | null>();
  return {
    pending,
    origin,
    fairAddress: address,
    amountSats: fairValueToSats(vout.value),
  };
}

/**
 * Persist a terminal-state record for a vout we received but cannot or will
 * not mint for (dust, cap exceeded, unsolicited, etc.). Either updates the
 * pending intent slot if one exists, or creates a fresh document keyed on
 * (fairTxid, fairVout) so the deposit is auditable and idempotent under
 * watcher re-scan.
 */
async function persistTerminalDeposit(args: {
  pending: DepositDoc | null;
  baseAddress: string;
  fairAddress: string;
  hdIndex: number;
  status: "FAILED";
  fairTxid: string;
  fairVout: number;
  fairBlockHeight: number;
  fairConfirmations: number;
  amountSats: bigint;
  amountWei: bigint;
}): Promise<void> {
  if (args.pending) {
    await Deposit.updateOne(
      { _id: args.pending._id },
      {
        $set: {
          status: args.status,
          fairTxid: args.fairTxid,
          fairVout: args.fairVout,
          fairBlockHeight: args.fairBlockHeight,
          fairConfirmations: args.fairConfirmations,
          amountSats: args.amountSats.toString(),
          amountWei: args.amountWei.toString(),
        },
      },
    );
    return;
  }
  await Deposit.create({
    baseAddress: args.baseAddress,
    fairAddress: args.fairAddress,
    hdIndex: args.hdIndex,
    status: args.status,
    fairTxid: args.fairTxid,
    fairVout: args.fairVout,
    fairBlockHeight: args.fairBlockHeight,
    fairConfirmations: args.fairConfirmations,
    amountSats: args.amountSats.toString(),
    amountWei: args.amountWei.toString(),
  });
}

async function processBlock(
  height: number,
  tip: number,
  addressSet: Set<string>,
): Promise<void> {
  const block = await getBlockAtHeight(height);
  if (block.tx.length === 0) return;
  const queue = createMintQueue();
  const confirmations = tip - height + 1;

  for (const tx of block.tx) {
    for (const vout of tx.vout) {
      const match = await matchVout(addressSet, tx, vout);
      if (!match) continue;

      // Idempotent: (fairTxid, fairVout) is unique; ignore repeat scans.
      const already = await Deposit.findOne({
        fairTxid: tx.txid,
        fairVout: vout.n,
      }).lean<DepositDoc | null>();
      if (already) continue;

      const amountSats = match.amountSats;
      const amountWei = amountSats * SATS_TO_WEI;
      const postFeeWei = applyFee(amountWei, config.BRIDGE_FEE_BPS);
      const minSats = BigInt(
        Math.round(config.MIN_DEPOSIT_FAIR * 100_000_000),
      );
      const perAddressCapSats = BigInt(
        Math.round(config.PER_ADDRESS_DAILY_CAP_FAIR * 100_000_000),
      );
      const maxTvlWei = BigInt(config.MAX_TVL_FAIR) * SATS_PER_FAIR * SATS_TO_WEI;

      // Users naturally re-use deposit addresses; each (txid, vout) is a
      // distinct deposit and gets its own document. `pending` is the open
      // intent slot (may be null on re-use); `origin` is the earliest
      // record for the address and the source of truth for baseAddress +
      // hdIndex inheritance.
      const origin = match.origin;
      const baseAddress = origin?.baseAddress ?? null;
      const hdIndex = origin?.hdIndex ?? -1;

      if (!baseAddress) {
        // Address is in our derivation set but no Deposit row exists at all
        // — should be unreachable (allocateNextDepositAddress always writes
        // a row), but guard anyway. Refund-required state.
        await Deposit.create({
          baseAddress: "0x0000000000000000000000000000000000000000",
          fairAddress: match.fairAddress,
          hdIndex,
          status: "FAILED",
          fairTxid: tx.txid,
          fairVout: vout.n,
          fairBlockHeight: height,
          fairConfirmations: confirmations,
          amountSats: amountSats.toString(),
          amountWei: amountWei.toString(),
        });
        await alert("unsolicited deposit to bridge address", {
          fairAddress: match.fairAddress,
          fairTxid: tx.txid,
          vout: vout.n,
          amountSats: amountSats.toString(),
        });
        continue;
      }

      if (amountSats < minSats) {
        await persistTerminalDeposit({
          pending: match.pending,
          baseAddress,
          fairAddress: match.fairAddress,
          hdIndex,
          status: "FAILED",
          fairTxid: tx.txid,
          fairVout: vout.n,
          fairBlockHeight: height,
          fairConfirmations: confirmations,
          amountSats,
          amountWei,
        });
        await alert("deposit below minimum — dust, no mint", {
          fairAddress: match.fairAddress,
          amountSats: amountSats.toString(),
          minSats: minSats.toString(),
        });
        continue;
      }

      // Per-address daily cap
      const dailySoFar = await sumDailyDepositSatsForAddress(baseAddress);
      if (dailySoFar + amountSats > perAddressCapSats) {
        await persistTerminalDeposit({
          pending: match.pending,
          baseAddress,
          fairAddress: match.fairAddress,
          hdIndex,
          status: "FAILED",
          fairTxid: tx.txid,
          fairVout: vout.n,
          fairBlockHeight: height,
          fairConfirmations: confirmations,
          amountSats,
          amountWei,
        });
        await alert("deposit exceeds per-address daily cap", {
          baseAddress,
          dailySoFar: dailySoFar.toString(),
          capSats: perAddressCapSats.toString(),
        });
        continue;
      }

      // TVL cap
      const [supply, inFlight] = await Promise.all([
        readWfairTotalSupply(),
        sumInFlightWei(),
      ]);
      if (supply + inFlight + postFeeWei > maxTvlWei) {
        await persistTerminalDeposit({
          pending: match.pending,
          baseAddress,
          fairAddress: match.fairAddress,
          hdIndex,
          status: "FAILED",
          fairTxid: tx.txid,
          fairVout: vout.n,
          fairBlockHeight: height,
          fairConfirmations: confirmations,
          amountSats,
          amountWei,
        });
        await alert("tvl cap exceeded — deposit failed, manual refund", {
          baseAddress,
          supply: supply.toString(),
          inFlight: inFlight.toString(),
          postFeeWei: postFeeWei.toString(),
          maxTvlWei: maxTvlWei.toString(),
        });
        continue;
      }

      // Happy path: confirm a deposit document.
      // - If a pending intent exists, transition it AWAITING/DETECTED →
      //   CONFIRMED in place (preserves the user's existing deposit id).
      // - Otherwise we're looking at address re-use; create a fresh doc
      //   inheriting baseAddress + hdIndex from origin and starting in
      //   CONFIRMED. The (fairTxid, fairVout) unique index makes the
      //   create idempotent under retry.
      let confirmedId: string;
      if (match.pending) {
        const updated = await Deposit.findOneAndUpdate(
          {
            _id: match.pending._id,
            status: { $in: ["AWAITING", "DETECTED"] },
          },
          {
            $set: {
              status: "CONFIRMED",
              fairTxid: tx.txid,
              fairVout: vout.n,
              fairBlockHeight: height,
              fairConfirmations: confirmations,
              amountSats: amountSats.toString(),
              amountWei: postFeeWei.toString(),
            },
          },
          { new: true },
        ).lean<DepositDoc | null>();
        if (!updated) {
          logger.debug(
            { fairTxid: tx.txid, vout: vout.n },
            "deposit no longer eligible for confirm (race)",
          );
          continue;
        }
        confirmedId = updated._id.toString();
      } else {
        try {
          const created = await Deposit.create({
            baseAddress,
            fairAddress: match.fairAddress,
            hdIndex,
            status: "CONFIRMED",
            fairTxid: tx.txid,
            fairVout: vout.n,
            fairBlockHeight: height,
            fairConfirmations: confirmations,
            amountSats: amountSats.toString(),
            amountWei: postFeeWei.toString(),
          });
          confirmedId = created._id.toString();
        } catch (err: unknown) {
          // E11000 duplicate key on (fairTxid, fairVout) — concurrent
          // watcher already created the row; treat as a no-op.
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("E11000")) {
            logger.debug(
              { fairTxid: tx.txid, vout: vout.n },
              "concurrent watcher created the re-use deposit row",
            );
            continue;
          }
          throw err;
        }
      }

      await queue.add(
        "mint",
        {
          depositId: confirmedId,
          baseAddress: getAddress(baseAddress),
          amountWei: postFeeWei.toString(),
          fairTxid: tx.txid,
          fairVout: vout.n,
        },
        { jobId: `mint:${tx.txid}:${vout.n}` },
      );

      logger.info(
        {
          depositId: confirmedId,
          fairTxid: tx.txid,
          vout: vout.n,
          amountSats: amountSats.toString(),
          postFeeWei: postFeeWei.toString(),
          reused: !match.pending,
        },
        "deposit confirmed — mint enqueued",
      );
    }
  }
}

/**
 * Re-enqueue any CONFIRMED deposits whose mint job never made it into Redis.
 * Same orphan pattern as the withdrawal-side reconciler in base-watcher.
 */
async function reconcileOrphanDeposits(): Promise<void> {
  const cutoff = new Date(Date.now() - ORPHAN_DEPOSIT_AGE_MS);
  const orphans = await Deposit.find({
    status: "CONFIRMED",
    createdAt: { $lt: cutoff },
    fairTxid: { $ne: null },
    fairVout: { $ne: null },
  })
    .limit(50)
    .lean<DepositDoc[]>();
  if (orphans.length === 0) return;
  const queue = createMintQueue();
  for (const orphan of orphans) {
    const fairTxid = orphan.fairTxid;
    const fairVout = orphan.fairVout;
    if (!fairTxid || fairVout === null || fairVout === undefined) continue;
    await queue.add(
      "mint",
      {
        depositId: orphan._id.toString(),
        baseAddress: getAddress(orphan.baseAddress),
        amountWei: orphan.amountWei,
        fairTxid,
        fairVout,
      },
      { jobId: `mint:${fairTxid}:${fairVout}` },
    );
    logger.warn(
      {
        depositId: orphan._id.toString(),
        fairTxid,
        fairVout,
      },
      "orphan deposit re-enqueued",
    );
  }
}

export async function startFairWatcher(signal: AbortSignal): Promise<void> {
  logger.info("fair-watcher starting");
  const addressSet = await getKnownDepositAddressSet();

  while (!signal.aborted) {
    try {
      await reconcileOrphanDeposits();
      const tip = await getTipHeight();
      const cursor = await EventCursor.findOneAndUpdate(
        { _id: "faircoin" },
        { $setOnInsert: { lastProcessedBlock: Math.max(0, tip - INITIAL_BACKFILL_BLOCKS) } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean<{ _id: string; lastProcessedBlock: number } | null>();
      const last = cursor?.lastProcessedBlock ?? tip - INITIAL_BACKFILL_BLOCKS;
      const safeTip = tip - config.FAIR_CONFIRMATIONS;
      if (safeTip > last) {
        for (let h = last + 1; h <= safeTip; h += 1) {
          if (signal.aborted) break;
          await processBlock(h, tip, addressSet);
          await EventCursor.updateOne(
            { _id: "faircoin" },
            { $set: { lastProcessedBlock: h } },
            { upsert: true },
          );
        }
      }
    } catch (err: unknown) {
      logger.error({ err }, "fair-watcher tick error");
    }
    await sleep(TICK_MS, signal);
  }
  logger.info("fair-watcher stopped");
}
