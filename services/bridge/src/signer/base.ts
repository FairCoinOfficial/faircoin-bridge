import Safe from "@safe-global/protocol-kit";
import SafeApiKit from "@safe-global/api-kit";
import { encodeFunctionData, pad, type Hash } from "viem";
import { config } from "../config.js";
import { AuditLog } from "../models/audit-log.js";
import { Deposit } from "../models/deposit.js";
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

async function signDirectEoa(job: MintJob): Promise<Hash> {
  const wallet = requireWallet();
  if (!wallet.account) {
    throw new Error("bridge wallet has no account configured");
  }
  const hash = await wallet.writeContract({
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
  return hash;
}

async function signSafeProposal(job: MintJob): Promise<Hash> {
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
  const signed = await safe.signTransaction(safeTx);
  const senderSignature = signed.getSignature(
    (await safe.getSafeProvider().getSignerAddress()) ?? "",
  );
  if (!senderSignature) {
    throw new Error("signTransaction returned no signature for our signer");
  }

  const apiKit = new SafeApiKit({
    chainId: BigInt(baseChain.id),
    txServiceUrl: config.SAFE_TX_SERVICE_URL,
  });
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
  const deposit = await Deposit.findById(job.depositId);
  if (!deposit) {
    logger.warn({ depositId: job.depositId }, "mint: deposit not found");
    return;
  }
  if (deposit.status === "MINTED") {
    logger.info({ depositId: job.depositId }, "mint: already minted, skip");
    return;
  }
  if (deposit.status === "FAILED") {
    throw new NonRetryableError(`deposit ${job.depositId} is FAILED`);
  }

  await Deposit.updateOne(
    { _id: deposit._id },
    { $set: { status: "MINTING" } },
  );

  try {
    const txHash =
      config.MINT_AUTH_MODE === "safe_proposal"
        ? await signSafeProposal(job)
        : await signDirectEoa(job);

    if (config.MINT_AUTH_MODE === "direct_eoa") {
      const receipt = await basePublic.waitForTransactionReceipt({
        hash: txHash,
      });
      if (receipt.status !== "success") {
        throw new Error(`mint tx reverted: ${txHash}`);
      }
      await Deposit.updateOne(
        { _id: deposit._id },
        {
          $set: {
            status: "MINTED",
            baseMintTxHash: txHash,
            baseMintBlockNumber: Number(receipt.blockNumber),
          },
        },
      );
    } else {
      // safe_proposal: leave in MINTING; a separate reconciler (phase 2)
      // watches the Safe for execution and transitions to MINTED.
      await Deposit.updateOne(
        { _id: deposit._id },
        { $set: { baseMintTxHash: txHash } },
      );
    }

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
