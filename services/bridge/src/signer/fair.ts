import { config } from "../config.js";
import { AuditLog } from "../models/audit-log.js";
import { Withdrawal } from "../models/withdrawal.js";
import { logger } from "../lib/logger.js";
import { sendToAddress, validateAddress } from "../rpc/fair.js";
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

export async function signRelease(job: ReleaseJob): Promise<void> {
  const withdrawal = await Withdrawal.findById(job.withdrawalId);
  if (!withdrawal) {
    logger.warn(
      { withdrawalId: job.withdrawalId },
      "release: withdrawal not found",
    );
    return;
  }
  if (withdrawal.status === "FINAL" || withdrawal.status === "BROADCAST") {
    logger.info(
      { withdrawalId: job.withdrawalId, status: withdrawal.status },
      "release: already processed, skip",
    );
    return;
  }
  if (withdrawal.status === "FAILED") {
    throw new NonRetryableError(
      `withdrawal ${job.withdrawalId} is FAILED`,
    );
  }

  if (config.FAIR_HOT_WALLET_MODE !== "node_wallet") {
    throw new NonRetryableError(
      `FAIR_HOT_WALLET_MODE=${config.FAIR_HOT_WALLET_MODE} not implemented (only node_wallet supported)`,
    );
  }

  const validation = await validateAddress(job.destinationFairAddress);
  if (!validation.isvalid) {
    await Withdrawal.updateOne(
      { _id: withdrawal._id },
      { $set: { status: "FAILED" } },
    );
    throw new NonRetryableError(
      `invalid faircoin address: ${job.destinationFairAddress}`,
    );
  }

  await Withdrawal.updateOne(
    { _id: withdrawal._id },
    { $set: { status: "SIGNING" } },
  );

  const amountFair = satsToFair(BigInt(job.amountSats));
  try {
    const txid = await sendToAddress(
      job.destinationFairAddress,
      amountFair,
    );
    await Withdrawal.updateOne(
      { _id: withdrawal._id },
      {
        $set: {
          status: "BROADCAST",
          fairTxid: txid,
          fairBroadcastAt: new Date(),
        },
      },
    );
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
  } catch (err: unknown) {
    logger.error(
      { err, withdrawalId: withdrawal._id.toString() },
      "release signing failed",
    );
    throw err;
  }
}
