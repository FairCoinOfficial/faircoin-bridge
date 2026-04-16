import Safe from "@safe-global/protocol-kit";
import SafeApiKit from "@safe-global/api-kit";
import {
  encodeFunctionData,
  pad,
  type Hash,
  type TransactionReceipt,
} from "viem";
import { config } from "../config.js";
import { AuditLog } from "../models/audit-log.js";
import { Deposit, type DepositDoc } from "../models/deposit.js";
import { basePublic, baseChain, requireWallet } from "../rpc/base.js";
import { wfairAbi } from "../rpc/wfair-abi.js";
import { logger } from "../lib/logger.js";
import { alert } from "../lib/alert.js";
import type { MintJob } from "../queues.js";

/**
 * Mint signer.
 *
 * Two modes:
 * - direct_eoa: fast path — bridge EOA holds MINTER_ROLE on WFAIR and calls
 *   mintForDeposit directly. TVL cap + pause are the risk backstops.
 * - safe_proposal: worker proposes a Safe tx and exits; 2nd signer + execution
 *   happen out-of-band via the Safe UI. Deposit sits in MINTING until ops acts.
 *
 * Idempotency invariant (CRITICAL — custodial funds):
 *   The on-chain side-effect identifier (Base tx hash for direct_eoa, Safe tx
 *   hash for safe_proposal) MUST be persisted to the deposit doc BEFORE the
 *   status is allowed to settle. On a retry of the same depositId, if the
 *   identifier is already on the doc we MUST NOT re-broadcast / re-propose:
 *   we reconcile against the chain / Safe API instead. Any path that calls
 *   writeContract or proposeTransaction without first checking + persisting
 *   the identifier is a double-mint vulnerability.
 */

function fairTxidToBytes32(txid: string): `0x${string}` {
  const hex = txid.startsWith("0x") ? txid.slice(2) : txid;
  if (hex.length !== 64) {
    throw new Error(`invalid fairTxid length: ${txid}`);
  }
  return pad(`0x${hex}`, { size: 32 });
}

function buildMintCalldata(job: MintJob): `0x${string}` {
  return encodeFunctionData({
    abi: wfairAbi,
    functionName: "mintForDeposit",
    args: [
      job.baseAddress as `0x${string}`,
      BigInt(job.amountWei),
      fairTxidToBytes32(job.fairTxid),
      job.fairVout,
    ],
  });
}

/**
 * Atomically claim the right to broadcast a mint for this deposit.
 *
 * Returns the claimed deposit on success. If the deposit has already been
 * claimed (status MINTING with a recorded txHash, or already MINTED/FAILED)
 * we return null and the caller switches to the reconciliation path.
 *
 * The compound filter on `baseMintTxHash: null` plus `safeTxHash: null` is
 * the actual mutex: only the worker that flips status to MINTING with both
 * hashes still null is allowed to broadcast. A second concurrent worker hits
 * an empty match and falls through to reconcile.
 */
async function claimMint(depositId: string): Promise<DepositDoc | null> {
  return await Deposit.findOneAndUpdate(
    {
      _id: depositId,
      status: { $in: ["CONFIRMED", "MINTING"] },
      baseMintTxHash: null,
      safeTxHash: null,
    },
    { $set: { status: "MINTING" } },
    { new: true },
  ).lean<DepositDoc | null>();
}

async function broadcastDirectEoa(job: MintJob): Promise<Hash> {
  const wallet = requireWallet();
  if (!wallet.account) {
    throw new Error("bridge wallet has no account configured");
  }
  return await wallet.writeContract({
    address: config.WFAIR_CONTRACT_ADDRESS as `0x${string}`,
    abi: wfairAbi,
    functionName: "mintForDeposit",
    args: [
      job.baseAddress as `0x${string}`,
      BigInt(job.amountWei),
      fairTxidToBytes32(job.fairTxid),
      job.fairVout,
    ],
    account: wallet.account,
    chain: baseChain,
  });
}

async function finalizeDirectEoa(
  depositId: string,
  txHash: Hash,
): Promise<TransactionReceipt> {
  const receipt = await basePublic.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    await Deposit.updateOne(
      { _id: depositId },
      { $set: { status: "FAILED" } },
    );
    await alert("mint tx reverted", { depositId, txHash });
    throw new Error(`mint tx reverted: ${txHash}`);
  }
  await Deposit.updateOne(
    { _id: depositId },
    {
      $set: {
        status: "MINTED",
        baseMintBlockNumber: Number(receipt.blockNumber),
      },
    },
  );
  return receipt;
}

async function signDirectEoa(
  job: MintJob,
  deposit: DepositDoc,
): Promise<Hash> {
  // Reconciliation path: the prior attempt got as far as broadcasting and
  // recorded the hash, but crashed before the receipt landed. Pick up the
  // existing tx — never broadcast a new one.
  if (deposit.baseMintTxHash) {
    const existing = deposit.baseMintTxHash as Hash;
    logger.warn(
      { depositId: deposit._id.toString(), txHash: existing },
      "mint: reconciling existing broadcast on retry",
    );
    await finalizeDirectEoa(deposit._id.toString(), existing);
    return existing;
  }

  // Fresh broadcast path. The order below is load-bearing: once
  // writeContract returns we have committed funds to the chain, so the very
  // next operation MUST be persisting the hash. If we crash between these
  // two lines the next retry will see baseMintTxHash=null and re-broadcast.
  const txHash = await broadcastDirectEoa(job);
  await Deposit.updateOne(
    { _id: deposit._id },
    { $set: { baseMintTxHash: txHash } },
  );
  await finalizeDirectEoa(deposit._id.toString(), txHash);
  return txHash;
}

interface SafeProposalContext {
  apiKit: SafeApiKit;
  safe: Awaited<ReturnType<typeof Safe.init>>;
}

async function buildSafeContext(): Promise<SafeProposalContext> {
  if (!config.BRIDGE_EOA_PRIVATE_KEY) {
    throw new Error(
      "BRIDGE_EOA_PRIVATE_KEY required for safe_proposal mode",
    );
  }
  const safe = await Safe.init({
    provider: config.BASE_RPC_URL,
    signer: config.BRIDGE_EOA_PRIVATE_KEY,
    safeAddress: config.SAFE_ADDRESS,
  });
  const apiKit = new SafeApiKit({
    chainId: BigInt(baseChain.id),
    txServiceUrl: config.SAFE_TX_SERVICE_URL,
  });
  return { safe, apiKit };
}

async function safeProposalExists(
  apiKit: SafeApiKit,
  safeTxHash: string,
): Promise<boolean> {
  try {
    await apiKit.getTransaction(safeTxHash);
    return true;
  } catch {
    // The Safe transaction service throws on 404; treat any failure as
    // "not found" and let the caller decide whether to (re)propose.
    return false;
  }
}

async function signSafeProposal(
  job: MintJob,
  deposit: DepositDoc,
): Promise<Hash> {
  const { safe, apiKit } = await buildSafeContext();

  // Reconciliation path: a prior attempt persisted a safeTxHash. Verify it
  // still exists on the Safe transaction service. If yes, leave the deposit
  // in MINTING (awaiting human approval) — the Safe-execution reconciler is
  // what flips it to MINTED. If no, we have an orphan record we can't trust
  // to re-derive a matching hash from (nonce may have advanced) so we alert
  // and refuse to silently re-propose.
  if (deposit.safeTxHash) {
    const existing = deposit.safeTxHash;
    if (await safeProposalExists(apiKit, existing)) {
      logger.info(
        { depositId: deposit._id.toString(), safeTxHash: existing },
        "mint: existing safe proposal still pending — awaiting approval",
      );
      return existing as Hash;
    }
    await alert("safe proposal hash on file but not found in Safe service", {
      depositId: deposit._id.toString(),
      safeTxHash: existing,
    });
    throw new Error(
      `safe proposal ${existing} missing from service; manual review required`,
    );
  }

  const data = buildMintCalldata(job);
  const safeTx = await safe.createTransaction({
    transactions: [
      {
        to: config.WFAIR_CONTRACT_ADDRESS,
        data,
        value: "0",
      },
    ],
  });
  const safeTxHash = await safe.getTransactionHash(safeTx);

  // Persist the hash BEFORE proposing. If we crash between these two lines
  // the retry will see safeTxHash on file, query the API, find nothing, and
  // refuse to re-propose — operator intervention required, but no duplicate
  // proposal. Better to fail safe than to mint twice.
  await Deposit.updateOne(
    { _id: deposit._id },
    { $set: { safeTxHash } },
  );

  const signed = await safe.signTransaction(safeTx);
  const senderSignature = signed.getSignature(
    (await safe.getSafeProvider().getSignerAddress()) ?? "",
  );
  if (!senderSignature) {
    throw new Error("signTransaction returned no signature for our signer");
  }

  await apiKit.proposeTransaction({
    safeAddress: config.SAFE_ADDRESS,
    safeTransactionData: signed.data,
    safeTxHash,
    senderAddress: senderSignature.signer,
    senderSignature: senderSignature.data,
  });

  await alert("mint proposal ready for Safe approval", {
    safeTxHash,
    baseAddress: job.baseAddress,
    amountWei: job.amountWei,
  });
  return safeTxHash as Hash;
}

export async function signMint(job: MintJob): Promise<void> {
  const initial = await Deposit.findById(job.depositId).lean<DepositDoc | null>();
  if (!initial) {
    logger.warn({ depositId: job.depositId }, "mint: deposit not found");
    return;
  }
  if (initial.status === "MINTED") {
    logger.info({ depositId: job.depositId }, "mint: already minted, skip");
    return;
  }
  if (initial.status === "FAILED") {
    throw new NonRetryableError(`deposit ${job.depositId} is FAILED`);
  }

  // Two retry-resume paths:
  //   1. status=MINTING with a hash already on file — reconcile, never re-send
  //   2. status=CONFIRMED with no hash yet — claim the slot, then send
  // claimMint encodes both as a single atomic findOneAndUpdate.
  let deposit = initial;
  if (!deposit.baseMintTxHash && !deposit.safeTxHash) {
    const claimed = await claimMint(job.depositId);
    if (!claimed) {
      // Lost the race or another worker is already broadcasting. Re-read and
      // fall through to the reconciliation branch.
      const fresh = await Deposit.findById(job.depositId).lean<
        DepositDoc | null
      >();
      if (!fresh) {
        logger.warn(
          { depositId: job.depositId },
          "mint: deposit disappeared mid-claim",
        );
        return;
      }
      deposit = fresh;
    } else {
      deposit = claimed;
    }
  }

  if (deposit.status !== "MINTING") {
    logger.warn(
      { depositId: job.depositId, status: deposit.status },
      "mint: unexpected status after claim — aborting to avoid re-broadcast",
    );
    return;
  }

  try {
    const txHash =
      config.MINT_AUTH_MODE === "safe_proposal"
        ? await signSafeProposal(job, deposit)
        : await signDirectEoa(job, deposit);

    await AuditLog.create({
      kind: "SIGN_MINT",
      actor: "bridge-signer",
      payload: {
        depositId: deposit._id.toString(),
        mode: config.MINT_AUTH_MODE,
        txHash,
        baseAddress: job.baseAddress,
        amountWei: job.amountWei,
        fairTxid: job.fairTxid,
        fairVout: job.fairVout,
      },
    });
  } catch (err: unknown) {
    logger.error({ err, depositId: job.depositId }, "mint signing failed");
    throw err;
  }
}

export class NonRetryableError extends Error {
  readonly nonRetryable = true;
}
