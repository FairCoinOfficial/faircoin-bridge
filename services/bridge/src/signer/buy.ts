import {
  getAddress,
  parseEther,
  type Address,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { config } from "../config.js";
import { AuditLog } from "../models/audit-log.js";
import { BuyOrder, type BuyOrderDoc } from "../models/buy-order.js";
import { logger } from "../lib/logger.js";
import { alert } from "../lib/alert.js";
import { fairAddressToBytes } from "../lib/fair-address-bytes.js";
import { deriveBuyPaymentKey } from "../hd/buy-payment.js";
import { basePublic, baseChain, requireWallet } from "../rpc/base.js";
import {
  erc20Abi,
  uniswapV3SwapRouterAbi,
} from "../rpc/uniswap-abi.js";
import { quoteWfairOutForExactUsdcIn } from "../rpc/uniswap.js";
import { wfairAbi } from "../rpc/wfair-abi.js";
import { NonRetryableError } from "./base.js";

const SLIPPAGE_BUFFER_FROM_QUOTE_BPS = 100n; // additional 1% leeway at exec time
const BPS_DENOM = 10_000n;
// We submit a single-pool swap on the live WFAIR/USDC v3 pool. Fee tier mirrors
// the deployed pool (3000 = 0.30%).
const POOL_FEE = 3000;

/**
 * Buy orchestrator.
 *
 * Runs once per BuyJob. The state machine is:
 *
 *   PAYMENT_DETECTED → SWAPPING → BURNING → DELIVERING
 *
 * After BURNING, the existing base-watcher picks up the BridgeBurn event and
 * the existing release pipeline (signRelease / faircoind sendtoaddress)
 * delivers FAIR to the user. We mark the BuyOrder DELIVERED only when its
 * destination address sees a release with the matching txid; that join lives
 * in `linkBurnToWithdrawal` (called from base-watcher.processLog).
 *
 * Idempotency invariant (CRITICAL — custodial funds):
 *   Each on-chain side-effect (USDC approve, Uniswap swap, bridgeBurn) MUST
 *   have its tx hash persisted to the BuyOrder doc BEFORE the next state
 *   transition. On retry, if a hash exists we wait for the receipt and skip
 *   re-broadcasting. The conditional `claimSwapping` / `claimBurning`
 *   findOneAndUpdate operations gate the broadcast.
 */

interface BuyContext {
  order: BuyOrderDoc;
  paymentKey: ReturnType<typeof deriveBuyPaymentKey>;
}

async function loadContext(buyOrderId: string): Promise<BuyContext | null> {
  const order = await BuyOrder.findById(buyOrderId).lean<BuyOrderDoc | null>();
  if (!order) return null;
  if (order.paymentHdIndex === null || order.paymentHdIndex === undefined) {
    throw new NonRetryableError(
      `buy order ${buyOrderId} has no paymentHdIndex (cannot resolve key)`,
    );
  }
  const paymentKey = deriveBuyPaymentKey(order.paymentHdIndex);
  if (
    order.paymentAddress &&
    getAddress(order.paymentAddress) !== paymentKey.address
  ) {
    throw new NonRetryableError(
      `buy order ${buyOrderId} payment address mismatch (db=${order.paymentAddress} derived=${paymentKey.address})`,
    );
  }
  return { order, paymentKey };
}

function paymentWalletClient(privateKey: `0x${string}`) {
  return createWalletClient({
    chain: baseChain,
    transport: http(config.BASE_RPC_URL),
    account: privateKeyToAccount(privateKey),
  });
}

// Per-order EOA gas budget. Three Base txs (approve + swap + bridgeBurn) at
// modern Base mainnet gas (~50 gwei * ~150k gas each) totals well under
// 0.0001 ETH; we send 0.0003 ETH to leave headroom for spikes and the
// occasional refund-to-bridge sweep. Excess remains on the address and is
// reclaimable with an explicit ops sweep tool.
const PAYMENT_GAS_TOPUP_ETH = "0.0003";

/**
 * Top up a per-order payment EOA with enough ETH to call approve + swap +
 * bridgeBurn. Idempotent: skips funding if the address already holds at
 * least the configured budget. Funded from BRIDGE_EOA_PRIVATE_KEY (the same
 * EOA that signs mint txs in direct_eoa mode).
 *
 * If BRIDGE_EOA_PRIVATE_KEY is unset (Safe-only deployment), this throws —
 * the operator must either fund payment EOAs out-of-band or wire a
 * paymaster. We surface that as a NonRetryableError so the buy job stops
 * pinging the queue.
 */
async function ensurePaymentGasBudget(address: Address): Promise<void> {
  const minBudget = parseEther(PAYMENT_GAS_TOPUP_ETH);
  const currentBalance = await basePublic.getBalance({ address });
  if (currentBalance >= minBudget) return;
  const needed = minBudget - currentBalance;
  let funder;
  try {
    funder = requireWallet();
  } catch (err: unknown) {
    throw new NonRetryableError(
      "buy: payment address has insufficient gas and BRIDGE_EOA_PRIVATE_KEY is not configured to fund it",
    );
  }
  if (!funder.account) {
    throw new NonRetryableError("bridge funder wallet has no account");
  }
  const txHash = await funder.sendTransaction({
    to: address,
    value: needed,
    chain: baseChain,
    account: funder.account,
  });
  const receipt = await basePublic.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`gas top-up reverted (${txHash})`);
  }
  logger.info(
    { address, txHash, fundedWei: needed.toString() },
    "buy: funded payment EOA with gas",
  );
}

async function readUsdcBalance(address: Address): Promise<bigint> {
  return basePublic.readContract({
    address: config.USDC_BASE_ADDRESS as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

async function readWfairBalance(address: Address): Promise<bigint> {
  return basePublic.readContract({
    address: config.WFAIR_CONTRACT_ADDRESS as `0x${string}`,
    abi: wfairAbi,
    functionName: "balanceOf",
    args: [address],
  });
}

async function ensureUsdcAllowance(
  ctx: BuyContext,
  amount: bigint,
): Promise<void> {
  const allowance = await basePublic.readContract({
    address: config.USDC_BASE_ADDRESS as `0x${string}`,
    abi: erc20Abi,
    functionName: "allowance",
    args: [ctx.paymentKey.address, config.UNISWAP_V3_SWAP_ROUTER as `0x${string}`],
  });
  if (allowance >= amount) return;
  const wallet = paymentWalletClient(ctx.paymentKey.privateKey);
  const hash = await wallet.writeContract({
    address: config.USDC_BASE_ADDRESS as `0x${string}`,
    abi: erc20Abi,
    functionName: "approve",
    args: [config.UNISWAP_V3_SWAP_ROUTER as `0x${string}`, amount],
    chain: baseChain,
    account: wallet.account,
  });
  const receipt = await basePublic.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`USDC approve reverted (${hash})`);
  }
  logger.info(
    { orderId: ctx.order._id.toString(), txHash: hash },
    "buy: USDC approval landed",
  );
}

async function claimSwapping(
  buyOrderId: string,
): Promise<BuyOrderDoc | null> {
  return await BuyOrder.findOneAndUpdate(
    {
      _id: buyOrderId,
      status: { $in: ["PAYMENT_DETECTED", "SWAPPING"] },
      swapTxHash: null,
    },
    { $set: { status: "SWAPPING" } },
    { new: true },
  ).lean<BuyOrderDoc | null>();
}

async function claimBurning(
  buyOrderId: string,
): Promise<BuyOrderDoc | null> {
  return await BuyOrder.findOneAndUpdate(
    {
      _id: buyOrderId,
      status: { $in: ["SWAPPING", "BURNING"] },
      burnTxHash: null,
      swapTxHash: { $ne: null },
    },
    { $set: { status: "BURNING" } },
    { new: true },
  ).lean<BuyOrderDoc | null>();
}

async function executeSwap(ctx: BuyContext): Promise<{
  txHash: Hash;
  wfairOut: bigint;
}> {
  // Always re-read balance: the user may have over-paid (great — extra
  // proceeds remain on the bridge address as buffer) or the original
  // detection-time balance may have changed.
  const usdcBalance = await readUsdcBalance(ctx.paymentKey.address);
  if (usdcBalance === 0n) {
    throw new NonRetryableError(
      `buy order ${ctx.order._id.toString()} has no USDC at payment address ${ctx.paymentKey.address}`,
    );
  }
  // Top up gas before any tx — approve + swap + burn together fit in our
  // budget. Idempotent across retries.
  await ensurePaymentGasBudget(ctx.paymentKey.address);
  await ensureUsdcAllowance(ctx, usdcBalance);

  // Re-quote at swap time so amountOutMinimum reflects the real spot price.
  const expectedWfair = await quoteWfairOutForExactUsdcIn(usdcBalance);
  // Quote → minimum-out adds a tighter execution-time slippage buffer than the
  // wider buffer added at quote time. The user's payment already accounts for
  // the wider buffer; this one protects against a small price tick during the
  // swap broadcast.
  const minOut =
    (expectedWfair * (BPS_DENOM - SLIPPAGE_BUFFER_FROM_QUOTE_BPS)) / BPS_DENOM;

  const wallet = paymentWalletClient(ctx.paymentKey.privateKey);
  const txHash = await wallet.writeContract({
    address: config.UNISWAP_V3_SWAP_ROUTER as `0x${string}`,
    abi: uniswapV3SwapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: config.USDC_BASE_ADDRESS as `0x${string}`,
        tokenOut: config.WFAIR_CONTRACT_ADDRESS as `0x${string}`,
        fee: POOL_FEE,
        recipient: ctx.paymentKey.address,
        amountIn: usdcBalance,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
    chain: baseChain,
    account: wallet.account,
  });

  // Persist the swap hash BEFORE waiting on the receipt. A crash after
  // writeContract returns would otherwise leave us re-broadcasting the same
  // swap on retry. With the hash on file, the retry path takes the receipt
  // wait branch instead.
  await BuyOrder.updateOne(
    { _id: ctx.order._id },
    { $set: { swapTxHash: txHash.toLowerCase() } },
  );

  const receipt = await basePublic.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    await BuyOrder.updateOne(
      { _id: ctx.order._id },
      {
        $set: {
          status: "FAILED",
          errorMessage: `Uniswap swap reverted (${txHash})`,
        },
      },
    );
    throw new Error(`Uniswap swap reverted: ${txHash}`);
  }
  const wfairOut = await readWfairBalance(ctx.paymentKey.address);
  await BuyOrder.updateOne(
    { _id: ctx.order._id },
    { $set: { swapWfairOut: wfairOut.toString() } },
  );
  logger.info(
    {
      orderId: ctx.order._id.toString(),
      txHash,
      usdcIn: usdcBalance.toString(),
      wfairOut: wfairOut.toString(),
    },
    "buy: swap landed",
  );
  return { txHash, wfairOut };
}

async function reconcileSwap(ctx: BuyContext): Promise<bigint> {
  if (!ctx.order.swapTxHash) {
    throw new Error("reconcileSwap called with no swapTxHash on file");
  }
  const txHash = ctx.order.swapTxHash as Hash;
  const receipt = await basePublic.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    await BuyOrder.updateOne(
      { _id: ctx.order._id },
      {
        $set: {
          status: "FAILED",
          errorMessage: `Uniswap swap reverted (${txHash})`,
        },
      },
    );
    throw new Error(`Uniswap swap reverted: ${txHash}`);
  }
  const wfairOut = await readWfairBalance(ctx.paymentKey.address);
  return wfairOut;
}

async function executeBurn(
  ctx: BuyContext,
  wfairAmount: bigint,
): Promise<Hash> {
  // The bridgeBurn caller must own the WFAIR. Our payment-address EOA
  // received the swap output, so we burn from there directly. This embeds the
  // user's FAIR address bytes in the BridgeBurn event for the existing
  // base-watcher to pick up.
  const wallet = paymentWalletClient(ctx.paymentKey.privateKey);
  const fairAddrBytes = fairAddressToBytes(ctx.order.fairDestinationAddress);
  const txHash = await wallet.writeContract({
    address: config.WFAIR_CONTRACT_ADDRESS as `0x${string}`,
    abi: wfairAbi,
    functionName: "bridgeBurn",
    args: [wfairAmount, fairAddrBytes],
    chain: baseChain,
    account: wallet.account,
  });
  await BuyOrder.updateOne(
    { _id: ctx.order._id },
    { $set: { burnTxHash: txHash.toLowerCase() } },
  );
  const receipt = await basePublic.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    await BuyOrder.updateOne(
      { _id: ctx.order._id },
      {
        $set: {
          status: "FAILED",
          errorMessage: `bridgeBurn reverted (${txHash})`,
        },
      },
    );
    throw new Error(`bridgeBurn reverted: ${txHash}`);
  }
  await BuyOrder.updateOne(
    { _id: ctx.order._id },
    { $set: { status: "DELIVERING" } },
  );
  logger.info(
    {
      orderId: ctx.order._id.toString(),
      txHash,
      wfairAmount: wfairAmount.toString(),
    },
    "buy: burn landed — release pipeline will deliver FAIR",
  );
  return txHash;
}

async function reconcileBurn(ctx: BuyContext): Promise<void> {
  if (!ctx.order.burnTxHash) {
    throw new Error("reconcileBurn called with no burnTxHash on file");
  }
  const txHash = ctx.order.burnTxHash as Hash;
  const receipt = await basePublic.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    await BuyOrder.updateOne(
      { _id: ctx.order._id },
      {
        $set: {
          status: "FAILED",
          errorMessage: `bridgeBurn reverted (${txHash})`,
        },
      },
    );
    throw new Error(`bridgeBurn reverted: ${txHash}`);
  }
  await BuyOrder.updateOne(
    { _id: ctx.order._id },
    { $set: { status: "DELIVERING" } },
  );
}

export async function processBuy(buyOrderId: string): Promise<void> {
  const ctx = await loadContext(buyOrderId);
  if (!ctx) {
    logger.warn({ buyOrderId }, "buy: order not found");
    return;
  }
  if (ctx.order.status === "DELIVERED" || ctx.order.status === "DELIVERING") {
    logger.info(
      { buyOrderId, status: ctx.order.status },
      "buy: already past burn, skip",
    );
    return;
  }
  if (ctx.order.status === "FAILED" || ctx.order.status === "EXPIRED") {
    throw new NonRetryableError(`buy order ${buyOrderId} status=${ctx.order.status}`);
  }

  // ── Swap ────────────────────────────────────────────────────────────────
  let order = ctx.order;
  let wfairOut: bigint;

  if (!order.swapTxHash) {
    const claimed = await claimSwapping(buyOrderId);
    if (!claimed) {
      // Race: another worker already claimed; reload and fall through to the
      // reconciliation branch below.
      const fresh = await BuyOrder.findById(buyOrderId).lean<BuyOrderDoc | null>();
      if (!fresh) return;
      order = fresh;
    } else {
      order = claimed;
    }
  }

  if (order.swapTxHash) {
    wfairOut = await reconcileSwap({ ...ctx, order });
  } else {
    if (order.status !== "SWAPPING") {
      logger.warn(
        { buyOrderId, status: order.status },
        "buy: unexpected status after swap claim — aborting",
      );
      return;
    }
    const swap = await executeSwap({ ...ctx, order });
    wfairOut = swap.wfairOut;
  }

  // Re-load after potential updates so subsequent steps see latest hashes.
  order = await BuyOrder.findById(buyOrderId).lean<BuyOrderDoc | null>() ?? order;

  // ── Burn ────────────────────────────────────────────────────────────────
  if (!order.burnTxHash) {
    const claimed = await claimBurning(buyOrderId);
    if (!claimed) {
      const fresh = await BuyOrder.findById(buyOrderId).lean<BuyOrderDoc | null>();
      if (!fresh) return;
      order = fresh;
    } else {
      order = claimed;
    }
  }

  if (order.burnTxHash) {
    await reconcileBurn({ ...ctx, order });
  } else {
    if (order.status !== "BURNING") {
      logger.warn(
        { buyOrderId, status: order.status },
        "buy: unexpected status after burn claim — aborting",
      );
      return;
    }
    await executeBurn({ ...ctx, order }, wfairOut);
  }

  await AuditLog.create({
    kind: "BUY_ORCHESTRATOR",
    actor: "bridge-buy",
    payload: {
      buyOrderId,
      paymentAddress: ctx.paymentKey.address,
      paymentCurrency: ctx.order.paymentCurrency,
      fairDestinationAddress: ctx.order.fairDestinationAddress,
      swapTxHash: order.swapTxHash,
      burnTxHash: order.burnTxHash,
    },
  }).catch((err: unknown) => {
    // Audit log failures are non-blocking: alert but don't unwind chain ops.
    logger.error({ err, buyOrderId }, "buy: audit log write failed");
    return alert("buy audit log write failed", { buyOrderId });
  });
}
