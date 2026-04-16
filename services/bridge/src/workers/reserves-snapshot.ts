import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { ReservesSnapshot } from "../models/reserves-snapshot.js";
import { basePublic } from "../rpc/base.js";
import { getWalletBalanceSats } from "../rpc/fair.js";
import { wfairAbi } from "../rpc/wfair-abi.js";

const TICK_MS = 60_000;
const SATS_TO_WEI = 10_000_000_000n; // 1e10

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

async function captureSnapshot(): Promise<void> {
  const [fairCustodySats, wfairSupplyWei] = await Promise.all([
    getWalletBalanceSats(),
    basePublic.readContract({
      address: config.WFAIR_CONTRACT_ADDRESS as `0x${string}`,
      abi: wfairAbi,
      functionName: "totalSupply",
    }),
  ]);

  const wfairSupplySats = wfairSupplyWei / SATS_TO_WEI;
  const deltaSats = fairCustodySats - wfairSupplySats;
  const pegHealthy = deltaSats >= 0n;

  await ReservesSnapshot.create({
    at: new Date(),
    fairCustodySats: fairCustodySats.toString(),
    wfairSupplyWei: wfairSupplyWei.toString(),
    deltaSats: deltaSats.toString(),
    pegHealthy,
  });

  logger.info(
    {
      fairCustodySats: fairCustodySats.toString(),
      wfairSupplyWei: wfairSupplyWei.toString(),
      deltaSats: deltaSats.toString(),
      pegHealthy,
    },
    "reserves snapshot captured",
  );
}

export async function startReservesSnapshot(
  signal: AbortSignal,
): Promise<void> {
  logger.info("reserves-snapshot starting");
  while (!signal.aborted) {
    try {
      await captureSnapshot();
    } catch (err: unknown) {
      logger.error({ err }, "reserves snapshot tick error");
    }
    await sleep(TICK_MS, signal);
  }
  logger.info("reserves-snapshot stopped");
}
