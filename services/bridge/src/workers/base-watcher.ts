import {
  decodeEventLog,
  getAbiItem,
  getAddress,
  hexToBytes,
  type AbiEvent,
  type Log,
} from "viem";
import { config } from "../config.js";
import { alert } from "../lib/alert.js";
import { logger } from "../lib/logger.js";
import { EventCursor } from "../models/event-cursor.js";
import { Withdrawal } from "../models/withdrawal.js";
import { createReleaseQueue } from "../queues.js";
import { basePublic } from "../rpc/base.js";
import { validateAddress } from "../rpc/fair.js";
import { wfairAbi } from "../rpc/wfair-abi.js";

const TICK_MS = 5000;
const INITIAL_BACKFILL_BLOCKS = 10_000n;
const SATS_TO_WEI = 10_000_000_000n; // 1e10
const BPS_DENOM = 10_000n;
const DAY_MS = 24 * 60 * 60 * 1000;

const bridgeBurnEvent = getAbiItem({
  abi: wfairAbi,
  name: "BridgeBurn",
}) as AbiEvent;

function applyFee(amount: bigint, feeBps: number): bigint {
  return (amount * (BPS_DENOM - BigInt(feeBps))) / BPS_DENOM;
}

function decodeFaircoinAddressBytes(hex: `0x${string}`): string {
  const bytes = hexToBytes(hex);
  return new TextDecoder().decode(bytes).trim();
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

async function sumDailyWithdrawalSatsForAddress(
  fromBaseAddress: string,
): Promise<bigint> {
  const since = new Date(Date.now() - DAY_MS);
  const rows = await Withdrawal.find(
    {
      fromBaseAddress: fromBaseAddress.toLowerCase(),
      createdAt: { $gte: since },
      status: { $in: ["CONFIRMED", "SIGNING", "BROADCAST", "FINAL"] },
    },
    { amountSats: 1 },
  ).lean<Array<{ amountSats: string }>>();
  let total = 0n;
  for (const row of rows) {
    try {
      total += BigInt(row.amountSats);
    } catch {
      // skip malformed
    }
  }
  return total;
}

interface DecodedBurn {
  from: `0x${string}`;
  amount: bigint;
  faircoinAddress: `0x${string}`;
}

function decodeBurn(log: Log): DecodedBurn | null {
  try {
    const decoded = decodeEventLog({
      abi: wfairAbi,
      eventName: "BridgeBurn",
      topics: log.topics,
      data: log.data,
    });
    return decoded.args as DecodedBurn;
  } catch (err: unknown) {
    logger.warn({ err, txHash: log.transactionHash }, "burn decode failed");
    return null;
  }
}

async function processLog(log: Log): Promise<void> {
  if (!log.transactionHash || log.logIndex === null || log.blockNumber === null) {
    logger.warn({ log }, "burn log missing identifiers — skipping");
    return;
  }
  const burn = decodeBurn(log);
  if (!burn) return;

  const txHash = log.transactionHash.toLowerCase();
  const logIndex = Number(log.logIndex);
  const blockNumber = Number(log.blockNumber);

  const existing = await Withdrawal.findOne({
    baseBurnTxHash: txHash,
    logIndex,
  }).lean();
  if (existing) return;

  const faircoinAddress = decodeFaircoinAddressBytes(burn.faircoinAddress);
  const amountWei = burn.amount;
  const amountSats = amountWei / SATS_TO_WEI;
  const fromBaseAddress = getAddress(burn.from).toLowerCase();
  const perAddressCapSats = BigInt(
    Math.round(config.PER_ADDRESS_DAILY_CAP_FAIR * 100_000_000),
  );

  // Validate destination before attempting release
  const validation = await validateAddress(faircoinAddress).catch(() => ({
    isvalid: false,
  }));
  if (!validation.isvalid) {
    await Withdrawal.create({
      baseBurnTxHash: txHash,
      baseBlockNumber: blockNumber,
      logIndex,
      fromBaseAddress,
      destinationFairAddress: faircoinAddress,
      amountWei: amountWei.toString(),
      amountSats: amountSats.toString(),
      status: "FAILED",
    });
    await alert("invalid faircoin address in bridge burn", {
      txHash,
      logIndex,
      faircoinAddress,
    });
    return;
  }

  const dailySoFar = await sumDailyWithdrawalSatsForAddress(fromBaseAddress);
  if (dailySoFar + amountSats > perAddressCapSats) {
    await Withdrawal.create({
      baseBurnTxHash: txHash,
      baseBlockNumber: blockNumber,
      logIndex,
      fromBaseAddress,
      destinationFairAddress: faircoinAddress,
      amountWei: amountWei.toString(),
      amountSats: amountSats.toString(),
      status: "FAILED",
    });
    await alert("withdrawal exceeds per-address daily cap", {
      fromBaseAddress,
      dailySoFar: dailySoFar.toString(),
      capSats: perAddressCapSats.toString(),
    });
    return;
  }

  const releaseAmountSats = applyFee(amountSats, config.BRIDGE_FEE_BPS);
  const releaseAmountWei = releaseAmountSats * SATS_TO_WEI;

  const doc = await Withdrawal.create({
    baseBurnTxHash: txHash,
    baseBlockNumber: blockNumber,
    logIndex,
    fromBaseAddress,
    destinationFairAddress: faircoinAddress,
    amountWei: releaseAmountWei.toString(),
    amountSats: releaseAmountSats.toString(),
    status: "CONFIRMED",
  });

  const queue = createReleaseQueue();
  await queue.add(
    "release",
    {
      withdrawalId: doc._id.toString(),
      destinationFairAddress: faircoinAddress,
      amountSats: releaseAmountSats.toString(),
      baseBurnTxHash: txHash,
      logIndex,
    },
    { jobId: `release:${txHash}:${logIndex}` },
  );

  logger.info(
    {
      withdrawalId: doc._id.toString(),
      txHash,
      logIndex,
      releaseAmountSats: releaseAmountSats.toString(),
    },
    "burn confirmed — release enqueued",
  );
}

export async function startBaseWatcher(signal: AbortSignal): Promise<void> {
  logger.info("base-watcher starting");

  while (!signal.aborted) {
    try {
      const tip = await basePublic.getBlockNumber();
      const cursor = await EventCursor.findOneAndUpdate(
        { _id: "base" },
        {
          $setOnInsert: {
            lastProcessedBlock:
              tip > INITIAL_BACKFILL_BLOCKS
                ? Number(tip - INITIAL_BACKFILL_BLOCKS)
                : 0,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean<{ _id: string; lastProcessedBlock: number } | null>();
      const last = BigInt(cursor?.lastProcessedBlock ?? 0);
      const safeTip = tip - BigInt(config.BASE_CONFIRMATIONS);

      if (safeTip > last) {
        const fromBlock = last + 1n;
        const toBlock = safeTip;
        const logs = await basePublic.getLogs({
          address: config.WFAIR_CONTRACT_ADDRESS as `0x${string}`,
          event: bridgeBurnEvent,
          fromBlock,
          toBlock,
        });
        for (const log of logs) {
          if (signal.aborted) break;
          await processLog(log);
        }
        await EventCursor.updateOne(
          { _id: "base" },
          { $set: { lastProcessedBlock: Number(safeTip) } },
          { upsert: true },
        );
      }
    } catch (err: unknown) {
      logger.error({ err }, "base-watcher tick error");
    }
    await sleep(TICK_MS, signal);
  }
  logger.info("base-watcher stopped");
}
