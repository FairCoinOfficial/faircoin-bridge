import { Queue, type JobsOptions } from "bullmq";
import { getRedis } from "./lib/redis.js";

export const QUEUE_MINT = "mint";
export const QUEUE_RELEASE = "release";
export const QUEUE_BUY = "buy";

export interface MintJob {
  depositId: string;
  baseAddress: string;
  amountWei: string;
  fairTxid: string;
  fairVout: number;
}

export interface ReleaseJob {
  withdrawalId: string;
  destinationFairAddress: string;
  amountSats: string;
  baseBurnTxHash: string;
  logIndex: number;
}

export interface BuyJob {
  buyOrderId: string;
}

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
};

let mintQueue: Queue<MintJob> | null = null;
let releaseQueue: Queue<ReleaseJob> | null = null;
let buyQueue: Queue<BuyJob> | null = null;

export function createMintQueue(): Queue<MintJob> {
  if (mintQueue) return mintQueue;
  mintQueue = new Queue<MintJob>(QUEUE_MINT, {
    connection: getRedis(),
    defaultJobOptions,
  });
  return mintQueue;
}

export function createReleaseQueue(): Queue<ReleaseJob> {
  if (releaseQueue) return releaseQueue;
  releaseQueue = new Queue<ReleaseJob>(QUEUE_RELEASE, {
    connection: getRedis(),
    defaultJobOptions,
  });
  return releaseQueue;
}

export function createBuyQueue(): Queue<BuyJob> {
  if (buyQueue) return buyQueue;
  buyQueue = new Queue<BuyJob>(QUEUE_BUY, {
    connection: getRedis(),
    defaultJobOptions,
  });
  return buyQueue;
}
