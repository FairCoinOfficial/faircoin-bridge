import { Worker, UnrecoverableError, type Job } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { alert } from "../lib/alert.js";
import {
  QUEUE_MINT,
  QUEUE_RELEASE,
  type MintJob,
  type ReleaseJob,
} from "../queues.js";
import { signMint, NonRetryableError } from "../signer/base.js";
import { signRelease } from "../signer/fair.js";

function wrapNonRetryable(err: unknown): unknown {
  if (err instanceof NonRetryableError) {
    return new UnrecoverableError(err.message);
  }
  return err;
}

async function mintProcessor(job: Job<MintJob>): Promise<void> {
  logger.info(
    { jobId: job.id, depositId: job.data.depositId },
    "mint job processing",
  );
  try {
    await signMint(job.data);
  } catch (err: unknown) {
    const wrapped = wrapNonRetryable(err);
    if (wrapped instanceof UnrecoverableError) {
      await alert("mint job failed permanently", {
        jobId: job.id,
        depositId: job.data.depositId,
        reason: wrapped.message,
      });
    }
    throw wrapped;
  }
}

async function releaseProcessor(job: Job<ReleaseJob>): Promise<void> {
  logger.info(
    { jobId: job.id, withdrawalId: job.data.withdrawalId },
    "release job processing",
  );
  try {
    await signRelease(job.data);
  } catch (err: unknown) {
    const wrapped = wrapNonRetryable(err);
    if (wrapped instanceof UnrecoverableError) {
      await alert("release job failed permanently", {
        jobId: job.id,
        withdrawalId: job.data.withdrawalId,
        reason: wrapped.message,
      });
    }
    throw wrapped;
  }
}

export function startMintWorker(signal: AbortSignal): Worker<MintJob> {
  const worker = new Worker<MintJob>(QUEUE_MINT, mintProcessor, {
    connection: getRedis(),
    concurrency: 1,
  });
  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, err, attemptsMade: job?.attemptsMade },
      "mint worker job failed",
    );
  });
  signal.addEventListener(
    "abort",
    () => {
      void worker.close();
    },
    { once: true },
  );
  return worker;
}

export function startReleaseWorker(signal: AbortSignal): Worker<ReleaseJob> {
  const worker = new Worker<ReleaseJob>(QUEUE_RELEASE, releaseProcessor, {
    connection: getRedis(),
    concurrency: 1,
  });
  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, err, attemptsMade: job?.attemptsMade },
      "release worker job failed",
    );
  });
  signal.addEventListener(
    "abort",
    () => {
      void worker.close();
    },
    { once: true },
  );
  return worker;
}
