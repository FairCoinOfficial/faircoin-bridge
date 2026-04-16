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
  existing: DepositDoc | null;
  fairAddress: string;
  amountSats: bigint;
}

async function matchVout(
  addressSet: Set<string>,
  tx: BlockTx,
  vout: TxVout,
): Promise<MatchedDeposit | null> {
  const address = voutAddress(vout);
  if (!address) return null;
  if (!addressSet.has(address)) return null;
  const existing = await Deposit.findOne({
    fairAddress: address,
  }).lean<DepositDoc | null>();
  return {
    existing,
    fairAddress: address,
    amountSats: fairValueToSats(vout.value),
  };
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

      const doc = match.existing;
      const baseAddress = doc
        ? doc.baseAddress
        : null;

      if (!baseAddress) {
        // Unsolicited send to a bridge-derived address (no prior intent) —
        // refuse to mint; operator must refund off-chain.
        await Deposit.create({
          baseAddress: "0x0000000000000000000000000000000000000000",
          fairAddress: match.fairAddress,
          hdIndex: doc?.hdIndex ?? -1,
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
        await Deposit.updateOne(
          { _id: doc?._id },
          {
            $set: {
              status: "FAILED",
              fairTxid: tx.txid,
              fairVout: vout.n,
              fairBlockHeight: height,
              fairConfirmations: confirmations,
              amountSats: amountSats.toString(),
              amountWei: amountWei.toString(),
            },
          },
        );
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
        await Deposit.updateOne(
          { _id: doc?._id },
          {
            $set: {
              status: "FAILED",
              fairTxid: tx.txid,
              fairVout: vout.n,
              fairBlockHeight: height,
              fairConfirmations: confirmations,
              amountSats: amountSats.toString(),
              amountWei: amountWei.toString(),
            },
          },
        );
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
        await Deposit.updateOne(
          { _id: doc?._id },
          {
            $set: {
              status: "FAILED",
              fairTxid: tx.txid,
              fairVout: vout.n,
              fairBlockHeight: height,
              fairConfirmations: confirmations,
              amountSats: amountSats.toString(),
              amountWei: amountWei.toString(),
            },
          },
        );
        await alert("tvl cap exceeded — deposit failed, manual refund", {
          baseAddress,
          supply: supply.toString(),
          inFlight: inFlight.toString(),
          postFeeWei: postFeeWei.toString(),
          maxTvlWei: maxTvlWei.toString(),
        });
        continue;
      }

      // Happy path: CONFIRMED + enqueue mint
      const updated = await Deposit.findOneAndUpdate(
        { _id: doc?._id, status: { $in: ["AWAITING", "DETECTED"] } },
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

      await queue.add(
        "mint",
        {
          depositId: updated._id.toString(),
          baseAddress: getAddress(baseAddress),
          amountWei: postFeeWei.toString(),
          fairTxid: tx.txid,
          fairVout: vout.n,
        },
        { jobId: `mint:${tx.txid}:${vout.n}` },
      );

      logger.info(
        {
          depositId: updated._id.toString(),
          fairTxid: tx.txid,
          vout: vout.n,
          amountSats: amountSats.toString(),
          postFeeWei: postFeeWei.toString(),
        },
        "deposit confirmed — mint enqueued",
      );
    }
  }
}

export async function startFairWatcher(signal: AbortSignal): Promise<void> {
  logger.info("fair-watcher starting");
  const addressSet = await getKnownDepositAddressSet();

  while (!signal.aborted) {
    try {
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
