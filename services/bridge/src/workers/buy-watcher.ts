import { getAddress, type Address } from "viem";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { BuyOrder, type BuyOrderDoc } from "../models/buy-order.js";
import { createBuyQueue } from "../queues.js";
import { basePublic } from "../rpc/base.js";
import { erc20Abi } from "../rpc/uniswap-abi.js";

/**
 * USDC payment watcher for the Buy flow.
 *
 * Polls the USDC `balanceOf` for every active payment address. When a balance
 * meets the order's `paymentAmount`, transitions the order to PAYMENT_DETECTED
 * and enqueues a buy job for the orchestrator to swap + burn.
 *
 * We use balance polling instead of `eth_getLogs` for two reasons:
 *   1. The watcher can run with a single multicall RPC per tick instead of
 *      one filter per address; cheaper at scale and avoids RPC log limits.
 *   2. Reorgs / block-pruning don't lose detection — the balance is always
 *      authoritative on the latest block.
 *
 * Per-order idempotency: claim AWAITING_PAYMENT → PAYMENT_DETECTED via a
 * conditional findOneAndUpdate so concurrent watcher ticks (or a stuck
 * previous tick that re-runs) cannot double-enqueue.
 *
 * Expiry: any order whose `paymentExpiresAt` has passed and is still
 * AWAITING_PAYMENT is moved to EXPIRED. The HD address is never reused.
 */

const TICK_MS = 5000;
// Cap the per-tick fan-out so a misconfigured RPC endpoint can't OOM the
// process by holding 1000s of pending readContract calls in flight.
const MAX_ORDERS_PER_TICK = 50;

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

async function readUsdcBalance(address: Address): Promise<bigint> {
  return basePublic.readContract({
    address: config.USDC_BASE_ADDRESS as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

async function expireStaleOrders(): Promise<void> {
  const now = new Date();
  const result = await BuyOrder.updateMany(
    {
      status: "AWAITING_PAYMENT",
      paymentExpiresAt: { $lt: now },
    },
    { $set: { status: "EXPIRED" } },
  );
  if (result.modifiedCount > 0) {
    logger.info(
      { expired: result.modifiedCount },
      "buy-watcher: expired stale quotes",
    );
  }
}

async function detectAwaitingOrders(): Promise<void> {
  const orders = await BuyOrder.find({
    status: "AWAITING_PAYMENT",
    paymentCurrency: "USDC_BASE",
    paymentAddress: { $ne: null },
    paymentExpiresAt: { $gte: new Date() },
  })
    .limit(MAX_ORDERS_PER_TICK)
    .lean<BuyOrderDoc[]>();
  if (orders.length === 0) return;

  const queue = createBuyQueue();

  for (const order of orders) {
    if (!order.paymentAddress) continue;
    let address: Address;
    try {
      address = getAddress(order.paymentAddress);
    } catch (err: unknown) {
      logger.warn(
        { err, orderId: order._id.toString() },
        "buy-watcher: skipping order with malformed payment address",
      );
      continue;
    }
    let balance: bigint;
    try {
      balance = await readUsdcBalance(address);
    } catch (err: unknown) {
      logger.warn(
        { err, orderId: order._id.toString(), address },
        "buy-watcher: balanceOf call failed; will retry next tick",
      );
      continue;
    }
    const required = BigInt(order.paymentAmount);
    if (balance < required) continue;

    // Atomically claim the detection slot. Concurrent watcher run lost the
    // race ⇒ no-op. The order has already been enqueued.
    const claimed = await BuyOrder.findOneAndUpdate(
      {
        _id: order._id,
        status: "AWAITING_PAYMENT",
      },
      {
        $set: {
          status: "PAYMENT_DETECTED",
          // We don't have a tx hash from a balance read; the orchestrator can
          // fill this in from a Transfer log lookup once it sweeps. Storing the
          // detected balance amount is more useful for audit.
          paymentDetectedTxHash: `balance:${balance.toString()}`,
        },
      },
      { new: true },
    ).lean<BuyOrderDoc | null>();
    if (!claimed) continue;

    await queue.add(
      "buy",
      { buyOrderId: claimed._id.toString() },
      { jobId: `buy:${claimed._id.toString()}` },
    );
    logger.info(
      {
        orderId: claimed._id.toString(),
        address: claimed.paymentAddress,
        balance: balance.toString(),
        required: required.toString(),
      },
      "buy-watcher: payment detected — orchestrator enqueued",
    );
  }
}

export async function startBuyWatcher(signal: AbortSignal): Promise<void> {
  // Refuse to start if buy HD isn't configured. The other watchers stay up
  // (deposit/withdraw paths are independent), and the API endpoint already
  // returns 503 to incoming /api/buy/quote calls.
  if (!config.BUY_PAYMENT_HD_XPRV && !config.BUY_PAYMENT_HD_MNEMONIC) {
    logger.warn(
      "buy-watcher disabled — neither BUY_PAYMENT_HD_XPRV nor BUY_PAYMENT_HD_MNEMONIC is configured",
    );
    return;
  }
  logger.info("buy-watcher starting");

  while (!signal.aborted) {
    try {
      await expireStaleOrders();
      await detectAwaitingOrders();
    } catch (err: unknown) {
      logger.error({ err }, "buy-watcher tick error");
    }
    await sleep(TICK_MS, signal);
  }
  logger.info("buy-watcher stopped");
}
