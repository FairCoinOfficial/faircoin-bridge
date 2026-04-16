import { config } from "../config.js";
import { AuditLog } from "../models/audit-log.js";
import { BuyOrder } from "../models/buy-order.js";
import { Withdrawal, type WithdrawalDoc } from "../models/withdrawal.js";
import { logger } from "../lib/logger.js";
import { alert } from "../lib/alert.js";
import {
  getRawTransaction,
  sendToAddress,
  validateAddress,
} from "../rpc/fair.js";
import type { ReleaseJob } from "../queues.js";
import { NonRetryableError } from "./base.js";

const SATS_PER_FAIR = 100_000_000;

function satsToFair(sats: bigint): number {
  // FairCoin sendtoaddress accepts 8-decimal FAIR floats. Construct via BigInt
  // math then convert to number at the last step — safe for amounts under 2^53.
  const whole = sats / BigInt(SATS_PER_FAIR);
  const frac = sats % BigInt(SATS_PER_FAIR);
  return Number(whole) + Number(frac) / SATS_PER_FAIR;
}

/**
 * Claim the broadcast slot for a withdrawal.
 *
 * Only one worker may flip CONFIRMED → SIGNING with no txid on file. Any
 * concurrent worker hits the filter's empty match and falls through to the
 * reconciliation branch (which never calls sendToAddress).
 */
async function claimRelease(
  withdrawalId: string,
): Promise<WithdrawalDoc | null> {
  return await Withdrawal.findOneAndUpdate(
    {
      _id: withdrawalId,
      status: { $in: ["CONFIRMED", "SIGNING"] },
      fairTxid: null,
    },
    { $set: { status: "SIGNING" } },
    { new: true },
  ).lean<WithdrawalDoc | null>();
}

/**
 * Verify a previously-broadcast tx by looking it up on the FairCoin node.
 * Returns true if found (in mempool or a block); throws for any non-"not
 * found" RPC error.
 */
async function fairTxExists(txid: string): Promise<boolean> {
  try {
    await getRawTransaction(txid);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // faircoind returns -5 for "No such mempool or blockchain transaction".
    if (message.includes("RPC -5") || message.includes("No such")) {
      return false;
    }
    throw err;
  }
}

/**
 * Idempotency requires fairTxid be persisted before status transition; never
 * call sendToAddress twice for the same withdrawal. On retry we reconcile
 * against the chain via getrawtransaction rather than re-broadcasting.
 */
export async function signNodeWallet(
  job: ReleaseJob,
  withdrawal: WithdrawalDoc,
): Promise<string> {
  // Reconciliation path: a prior attempt got as far as sendToAddress
  // returning a txid, but crashed before the status update. If the tx can
  // be found on the node (mempool or confirmed), finalize; do NOT re-send.
  if (withdrawal.fairTxid) {
    const txid = withdrawal.fairTxid;
    logger.warn(
      { withdrawalId: withdrawal._id.toString(), txid },
      "release: reconciling existing broadcast on retry",
    );
    const exists = await fairTxExists(txid);
    if (exists) {
      await Withdrawal.updateOne(
        { _id: withdrawal._id },
        {
          $set: {
            status: "BROADCAST",
            fairBroadcastAt: withdrawal.fairBroadcastAt ?? new Date(),
          },
        },
      );
      return txid;
    }
    // Hash on file but node has no memory of it — unusual but possible if
    // the original broadcast never actually hit the network. Alert and fail
    // closed: re-broadcasting the same key+nonce via sendToAddress would
    // produce a *different* txid and potentially double-spend inputs.
    await alert("release txid on file but not found on node", {
      withdrawalId: withdrawal._id.toString(),
      txid,
    });
    throw new Error(
      `release ${withdrawal._id.toString()} has txid ${txid} on file but node RPC reports no such tx`,
    );
  }

  // Fresh broadcast path. The order below is load-bearing: sendToAddress is
  // the only non-idempotent side-effect in this service. Once it returns a
  // txid the funds have committed; the very next operation MUST persist the
  // txid. A crash between these two lines before the DB write would let the
  // retry re-send and double-spend.
  const amountFair = satsToFair(BigInt(job.amountSats));
  const txid = await sendToAddress(job.destinationFairAddress, amountFair);
  await Withdrawal.updateOne(
    { _id: withdrawal._id },
    {
      $set: {
        fairTxid: txid,
        fairBroadcastAt: new Date(),
      },
    },
  );
  await Withdrawal.updateOne(
    { _id: withdrawal._id },
    { $set: { status: "BROADCAST" } },
  );
  return txid;
}

export async function signRelease(job: ReleaseJob): Promise<void> {
  const initial = await Withdrawal.findById(
    job.withdrawalId,
  ).lean<WithdrawalDoc | null>();
  if (!initial) {
    logger.warn(
      { withdrawalId: job.withdrawalId },
      "release: withdrawal not found",
    );
    return;
  }
  if (initial.status === "FINAL" || initial.status === "BROADCAST") {
    logger.info(
      { withdrawalId: job.withdrawalId, status: initial.status },
      "release: already processed, skip",
    );
    return;
  }
  if (initial.status === "FAILED") {
    throw new NonRetryableError(
      `withdrawal ${job.withdrawalId} is FAILED`,
    );
  }

  if (config.FAIR_HOT_WALLET_MODE !== "node_wallet") {
    throw new NonRetryableError(
      `FAIR_HOT_WALLET_MODE=${config.FAIR_HOT_WALLET_MODE} not implemented (only node_wallet supported)`,
    );
  }

  // Validate ONLY on the fresh-broadcast path. If we already broadcast and
  // are reconciling, address validity is moot — the tx is on the wire and
  // we must not flip status to FAILED and lose track of fairTxid.
  if (!initial.fairTxid) {
    const validation = await validateAddress(job.destinationFairAddress);
    if (!validation.isvalid) {
      await Withdrawal.updateOne(
        { _id: initial._id },
        { $set: { status: "FAILED" } },
      );
      throw new NonRetryableError(
        `invalid faircoin address: ${job.destinationFairAddress}`,
      );
    }
  }

  // Two retry-resume paths:
  //   1. status=SIGNING with a txid already on file — reconcile via RPC
  //   2. status=CONFIRMED with no txid yet — claim the slot then broadcast
  let withdrawal = initial;
  if (!withdrawal.fairTxid) {
    const claimed = await claimRelease(job.withdrawalId);
    if (!claimed) {
      const fresh = await Withdrawal.findById(
        job.withdrawalId,
      ).lean<WithdrawalDoc | null>();
      if (!fresh) {
        logger.warn(
          { withdrawalId: job.withdrawalId },
          "release: withdrawal disappeared mid-claim",
        );
        return;
      }
      withdrawal = fresh;
    } else {
      withdrawal = claimed;
    }
  }

  if (withdrawal.status !== "SIGNING") {
    logger.warn(
      { withdrawalId: job.withdrawalId, status: withdrawal.status },
      "release: unexpected status after claim — aborting to avoid re-broadcast",
    );
    return;
  }

  try {
    const txid = await signNodeWallet(job, withdrawal);
    await AuditLog.create({
      kind: "SIGN_RELEASE",
      actor: "bridge-signer",
      payload: {
        withdrawalId: withdrawal._id.toString(),
        destinationFairAddress: job.destinationFairAddress,
        amountSats: job.amountSats,
        txid,
        mode: config.FAIR_HOT_WALLET_MODE,
      },
    });
    logger.info(
      {
        withdrawalId: withdrawal._id.toString(),
        txid,
        amountSats: job.amountSats,
      },
      "release broadcast",
    );
    // If this release closes a Buy order (the burn tx was emitted by our
    // buy orchestrator), thread the FAIR delivery txid back so the wallet's
    // status poll flips DELIVERING → DELIVERED. Best-effort: failures here
    // do not impact the withdrawal pipeline.
    await linkReleaseToBuyOrder(job.baseBurnTxHash, txid).catch(
      (err: unknown) => {
        logger.warn(
          { err, baseBurnTxHash: job.baseBurnTxHash },
          "release: BuyOrder linking failed (non-blocking)",
        );
      },
    );
  } catch (err: unknown) {
    logger.error(
      { err, withdrawalId: withdrawal._id.toString() },
      "release signing failed",
    );
    throw err;
  }
}

/**
 * If `baseBurnTxHash` corresponds to a BuyOrder we orchestrated, mark it as
 * DELIVERED with the faircoind txid that just settled the FAIR side. The
 * BuyOrder's `burnTxHash` is set by the buy orchestrator before bridgeBurn
 * is broadcast, so the join is exact (no address-based fuzzy matching).
 */
async function linkReleaseToBuyOrder(
  baseBurnTxHash: string,
  fairReleaseTxid: string,
): Promise<void> {
  const updated = await BuyOrder.findOneAndUpdate(
    {
      burnTxHash: baseBurnTxHash.toLowerCase(),
      status: { $in: ["BURNING", "DELIVERING"] },
    },
    {
      $set: {
        status: "DELIVERED",
        releaseFairTxId: fairReleaseTxid,
      },
    },
    { new: true },
  ).lean<{ _id: { toString(): string } } | null>();
  if (updated) {
    logger.info(
      {
        buyOrderId: updated._id.toString(),
        baseBurnTxHash,
        fairReleaseTxid,
      },
      "buy: order delivered",
    );
  }
}
