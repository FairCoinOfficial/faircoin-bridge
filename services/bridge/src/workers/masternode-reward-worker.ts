import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { alert } from "../lib/alert.js";
import { AuditLog } from "../models/audit-log.js";
import {
  MasternodeRewardCycle,
  type MasternodeRewardCycleDoc,
} from "../models/masternode-reward-cycle.js";
import {
  getMasternodeList,
  getRawTransaction,
  getReceivedByAddressSats,
  sendToAddress,
  type MasternodeListEntry,
} from "../rpc/fair.js";

/**
 * Masternode reward booster.
 *
 * Periodically reads the FAIR balance accumulated at
 * `FAIR_MASTERNODE_REWARD_ADDRESS` (funded by the buy-back worker's 20%
 * slice — see services/bridge task #28) and distributes it pro-rata across
 * all `ENABLED` FairCoin masternodes via faircoind `sendtoaddress`. Every
 * cycle is persisted as a `MasternodeRewardCycle` row so the operator can
 * audit historical distributions and the worker can resume mid-cycle after
 * a crash.
 *
 * Idempotency contract (mirrors src/signer/fair.ts):
 *   - Each per-masternode payout is a row in `cycle.payouts[]` keyed by
 *     `masternodeOutpoint` ("txhash-outidx").
 *   - `sendtoaddress` is the only non-idempotent call; we persist the
 *     returned txid BEFORE flipping the payout status to BROADCAST. A crash
 *     between those two writes leaves the payout in PENDING with a txid on
 *     file; the next tick reconciles by looking up the txid via
 *     `getrawtransaction` rather than re-sending.
 *   - On retry, payouts that already have a non-null txid are NEVER re-sent.
 *     If `getrawtransaction` cannot find the txid, the payout is marked
 *     FAILED and the cycle continues with the remaining masternodes (the
 *     missing tx is alerted to the operator; we never try to "recover" by
 *     re-broadcasting because that would risk double-spending the same
 *     UTXOs into a new tx and double-paying the masternode).
 */

const SATS_PER_FAIR = 100_000_000n;

/**
 * Convert a sats bigint into a FAIR float for `sendtoaddress`. Mirror of the
 * helper in src/signer/fair.ts; intentionally inlined here so the two
 * workers can be reasoned about independently — the helper is two lines and
 * sharing a util is over-engineering for the single use site each.
 */
function satsToFair(sats: bigint): number {
  const whole = sats / SATS_PER_FAIR;
  const frac = sats % SATS_PER_FAIR;
  return Number(whole) + Number(frac) / Number(SATS_PER_FAIR);
}

/**
 * Convert a FAIR float (whole units, 8 decimals) into sats. Multiplies via
 * Math.round on the 8-decimal product to avoid float drift on inputs like
 * 0.001 * 1e8 (= 99999.99999999999 in IEEE-754). Caller-side validation
 * ensures inputs are non-negative finite numbers.
 */
function fairToSats(fair: number): bigint {
  return BigInt(Math.round(fair * Number(SATS_PER_FAIR)));
}

/**
 * Treat masternodes whose `status` field equals "ENABLED" as eligible for
 * payout. faircoind's masternodelist surfaces several other states
 * ("EXPIRED", "REMOVE", "POSE_BAN", etc.) — none of those should receive
 * the reward, since paying an expired/banned operator both wastes the pool
 * and rewards bad behaviour. We are intentionally strict here; if/when
 * faircoind adds a new "valid + active" status the worker will skip those
 * masternodes until this allowlist is updated.
 */
const ELIGIBLE_STATUS = "ENABLED";

function isEligible(entry: MasternodeListEntry): boolean {
  return entry.status === ELIGIBLE_STATUS;
}

function outpointKey(entry: MasternodeListEntry): string {
  return `${entry.txhash}-${String(entry.outidx)}`;
}

/**
 * Re-export-style helper so tests can mock `sendToAddress` while still
 * exercising the worker's idempotency state machine. Production code never
 * needs to override this — it is a thin shim.
 */
async function broadcastPayout(
  address: string,
  amountSats: bigint,
): Promise<string> {
  return sendToAddress(address, satsToFair(amountSats));
}

/**
 * Try to reconcile a payout that already has a txid on file by checking the
 * faircoind node. Returns true if the tx exists (mempool or block); false if
 * the daemon confirms it does not exist (RPC -5). Throws on every other RPC
 * error — those are transient and should retry the next tick.
 */
async function fairTxExists(txid: string): Promise<boolean> {
  try {
    await getRawTransaction(txid);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("RPC -5") || message.includes("No such")) {
      return false;
    }
    throw err;
  }
}

/**
 * Compute per-masternode payout in sats, after subtracting the per-payout
 * fee budget × N. Returns 0n if the fee reservation would consume the
 * entire pool (caller treats that as SKIPPED_BELOW_THRESHOLD).
 */
function computePerMasternodeSats(
  poolSats: bigint,
  masternodeCount: number,
  payoutFeeFair: number,
): bigint {
  if (masternodeCount <= 0) return 0n;
  const feeBudgetSats =
    fairToSats(payoutFeeFair) * BigInt(masternodeCount);
  if (poolSats <= feeBudgetSats) return 0n;
  const distributable = poolSats - feeBudgetSats;
  return distributable / BigInt(masternodeCount);
}

/**
 * Build a Set of outpoints for masternodes already paid in a prior partial
 * cycle attempt. Caller uses it to skip those when issuing fresh sends.
 */
function alreadyBroadcastOutpoints(
  cycle: MasternodeRewardCycleDoc,
): Set<string> {
  const out = new Set<string>();
  for (const p of cycle.payouts) {
    const hasTxid = (p.txid ?? null) !== null;
    if (hasTxid && (p.status === "BROADCAST" || p.status === "CONFIRMED")) {
      out.add(p.masternodeOutpoint);
    }
  }
  return out;
}

/**
 * Atomically claim the next runnable cycle. There are two cases:
 *   1. A prior tick crashed mid-broadcast — we find a row with status
 *      PAYING_OUT and resume it.
 *   2. No claimable in-flight cycle exists — return null and the caller
 *      decides whether to start a fresh one (subject to interval gating).
 *
 * Note: PENDING is also a resumable state in case the worker crashed
 * between row insertion and the first sendtoaddress call. We use a single
 * findOneAndUpdate to flip PENDING/PAYING_OUT → PAYING_OUT, preventing two
 * worker replicas from stepping on each other.
 */
async function claimResumableCycle(): Promise<MasternodeRewardCycleDoc | null> {
  return await MasternodeRewardCycle.findOneAndUpdate(
    { status: { $in: ["PENDING", "PAYING_OUT"] } },
    { $set: { status: "PAYING_OUT" } },
    { new: true, sort: { createdAt: 1 } },
  ).lean<MasternodeRewardCycleDoc | null>();
}

/**
 * Has any cycle started since the cutoff? Used to enforce the interval
 * cadence so a process restart inside the interval doesn't fire a redundant
 * payout cycle on top of one that already happened.
 */
async function hasRecentCycle(cutoff: Date): Promise<boolean> {
  const recent = await MasternodeRewardCycle.findOne({
    triggeredAt: { $gte: cutoff },
  })
    .select({ _id: 1 })
    .lean();
  return recent !== null;
}

/**
 * Read the pool balance from the configured reward address. Throws on
 * misconfig (`FAIR_MASTERNODE_REWARD_ADDRESS` blank), so callers can fail
 * loud at the top of the tick rather than half-completing a cycle.
 */
async function readPoolBalanceSats(): Promise<bigint> {
  const address = config.FAIR_MASTERNODE_REWARD_ADDRESS;
  if (!address) {
    throw new Error(
      "FAIR_MASTERNODE_REWARD_ADDRESS is not set; cannot size pool balance",
    );
  }
  return await getReceivedByAddressSats(address);
}

/**
 * Plain (non-mongoose-DocumentArray) shape of a fresh payout sub-doc passed
 * into `MasternodeRewardCycle.create({ payouts: [...] })`. Mongoose hydrates
 * the array into a DocumentArray automatically; we only need a shape that
 * is structurally assignable to the schema's element type for input.
 */
interface FreshPayoutInput {
  masternodeOutpoint: string;
  payoutAddress: string;
  amountSats: string;
  status: "PENDING";
  txid: null;
  errorMessage: null;
}

/**
 * Build the payouts[] array on a fresh cycle. Each entry starts in PENDING
 * with a null txid so the broadcast loop can pick them up.
 */
function buildPayouts(
  masternodes: MasternodeListEntry[],
  perMasternodeSats: bigint,
): FreshPayoutInput[] {
  return masternodes.map((mn) => ({
    masternodeOutpoint: outpointKey(mn),
    payoutAddress: mn.addr,
    amountSats: perMasternodeSats.toString(),
    status: "PENDING" as const,
    txid: null,
    errorMessage: null,
  }));
}

/**
 * Execute one cycle's payouts to completion (or partial completion + cycle
 * marked FAILED on unrecoverable errors). Returns the final cycle doc so
 * callers can audit the result. Mutates `cycle` in place via Mongo updates.
 */
async function executeCycle(cycle: MasternodeRewardCycleDoc): Promise<void> {
  const skipOutpoints = alreadyBroadcastOutpoints(cycle);
  let anyFailed = false;

  for (let i = 0; i < cycle.payouts.length; i += 1) {
    const payout = cycle.payouts[i];
    if (payout === undefined) continue;

    // Reconciliation path: payout already has a txid (prior crash mid-write).
    // NEVER re-broadcast — look up the tx and finalise the row.
    const existingTxid = payout.txid ?? null;
    if (existingTxid !== null) {
      if (payout.status === "BROADCAST" || payout.status === "CONFIRMED") {
        continue;
      }
      const exists = await fairTxExists(existingTxid);
      if (exists) {
        await markPayoutBroadcast(cycle._id, i, existingTxid);
        continue;
      }
      // Hash on file but daemon has no record. We can't safely re-send (a
      // new sendtoaddress would build a different tx that might conflict
      // on inputs); mark FAILED and alert.
      const reason = `payout txid ${existingTxid} on file but not found on node`;
      await markPayoutFailed(cycle._id, i, reason);
      await alert("masternode reward payout txid missing from node", {
        cycleId: cycle._id.toString(),
        outpoint: payout.masternodeOutpoint,
        txid: existingTxid,
      });
      anyFailed = true;
      continue;
    }

    // Fresh broadcast path. Skip if a parallel run somehow left this
    // outpoint already paid (alreadyBroadcastOutpoints catches the
    // straightforward case; this is defence-in-depth against the unlikely
    // race where two cycles target the same outpoint).
    if (skipOutpoints.has(payout.masternodeOutpoint)) continue;

    try {
      const amountSats = BigInt(payout.amountSats);
      const txid = await broadcastPayout(payout.payoutAddress, amountSats);
      // Persist txid BEFORE flipping status — same load-bearing ordering as
      // src/signer/fair.ts. A crash between these two writes leaves the
      // reconciliation branch above to resume.
      await persistPayoutTxid(cycle._id, i, txid);
      await markPayoutBroadcast(cycle._id, i, txid);
      logger.info(
        {
          cycleId: cycle._id.toString(),
          outpoint: payout.masternodeOutpoint,
          payoutAddress: payout.payoutAddress,
          amountSats: amountSats.toString(),
          txid,
        },
        "masternode reward payout broadcast",
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          err,
          cycleId: cycle._id.toString(),
          outpoint: payout.masternodeOutpoint,
        },
        "masternode reward payout failed",
      );
      await markPayoutFailed(cycle._id, i, message);
      await alert("masternode reward payout failed", {
        cycleId: cycle._id.toString(),
        outpoint: payout.masternodeOutpoint,
        error: message,
      });
      anyFailed = true;
    }
  }

  // Finalise cycle. If any payout is still PENDING after the loop (e.g. a
  // skipOutpoints hit), the cycle stays in PAYING_OUT and the next tick
  // resumes it. We only flip terminal statuses when every payout has a
  // BROADCAST/CONFIRMED/FAILED outcome.
  const fresh = await MasternodeRewardCycle.findById(cycle._id).lean<
    MasternodeRewardCycleDoc | null
  >();
  if (!fresh) return;
  const allFinal = fresh.payouts.every(
    (p) => p.status === "BROADCAST" || p.status === "CONFIRMED" || p.status === "FAILED",
  );
  if (!allFinal) return;

  const status: "COMPLETE" | "FAILED" = anyFailed ? "FAILED" : "COMPLETE";
  await MasternodeRewardCycle.updateOne(
    { _id: cycle._id, status: "PAYING_OUT" },
    {
      $set: {
        status,
        errorMessage: anyFailed
          ? "one or more payouts failed; see payouts[].errorMessage"
          : null,
      },
    },
  );
  await AuditLog.create({
    kind: "MASTERNODE_REWARD_CYCLE",
    actor: "masternode-reward-worker",
    payload: {
      cycleId: cycle._id.toString(),
      poolBalanceFair: fresh.poolBalanceFair,
      activeMasternodes: fresh.activeMasternodes,
      perMasternodeFair: fresh.perMasternodeFair,
      status,
      payouts: fresh.payouts.length,
    },
  });
  logger.info(
    {
      cycleId: cycle._id.toString(),
      status,
      payouts: fresh.payouts.length,
    },
    "masternode reward cycle finalised",
  );
}

async function persistPayoutTxid(
  cycleId: MasternodeRewardCycleDoc["_id"],
  index: number,
  txid: string,
): Promise<void> {
  await MasternodeRewardCycle.updateOne(
    { _id: cycleId },
    { $set: { [`payouts.${String(index)}.txid`]: txid } },
  );
}

async function markPayoutBroadcast(
  cycleId: MasternodeRewardCycleDoc["_id"],
  index: number,
  txid: string,
): Promise<void> {
  await MasternodeRewardCycle.updateOne(
    { _id: cycleId },
    {
      $set: {
        [`payouts.${String(index)}.status`]: "BROADCAST",
        [`payouts.${String(index)}.txid`]: txid,
      },
    },
  );
}

async function markPayoutFailed(
  cycleId: MasternodeRewardCycleDoc["_id"],
  index: number,
  errorMessage: string,
): Promise<void> {
  await MasternodeRewardCycle.updateOne(
    { _id: cycleId },
    {
      $set: {
        [`payouts.${String(index)}.status`]: "FAILED",
        [`payouts.${String(index)}.errorMessage`]: errorMessage,
      },
    },
  );
}

/**
 * Create a SKIPPED row so the operator's status endpoint can see the worker
 * is alive even when no payouts happen. Audit-logs the skip reason too.
 */
async function recordSkip(
  status:
    | "SKIPPED_DISABLED"
    | "SKIPPED_BELOW_THRESHOLD"
    | "SKIPPED_NO_MASTERNODES",
  context: {
    poolBalanceSats: bigint;
    activeMasternodes: number;
    perMasternodeSats?: bigint;
  },
): Promise<void> {
  const cycle = await MasternodeRewardCycle.create({
    triggeredAt: new Date(),
    poolBalanceFair: context.poolBalanceSats.toString(),
    activeMasternodes: context.activeMasternodes,
    perMasternodeFair: (context.perMasternodeSats ?? 0n).toString(),
    payouts: [],
    status,
  });
  await AuditLog.create({
    kind: "MASTERNODE_REWARD_CYCLE",
    actor: "masternode-reward-worker",
    payload: {
      cycleId: cycle._id.toString(),
      status,
      poolBalanceSats: context.poolBalanceSats.toString(),
      activeMasternodes: context.activeMasternodes,
    },
  });
  logger.info(
    {
      cycleId: cycle._id.toString(),
      status,
      poolBalanceSats: context.poolBalanceSats.toString(),
      activeMasternodes: context.activeMasternodes,
    },
    "masternode reward cycle skipped",
  );
}

/**
 * One iteration of the loop. Pure function over RPC + Mongo state — no
 * timers, no signal handling. The startMasternodeRewardWorker wrapper takes
 * care of cadence and abort signalling.
 */
export async function runMasternodeRewardTick(): Promise<void> {
  if (!config.MASTERNODE_REWARDS_ENABLED) {
    // Disabled: do not even create a SKIPPED row — that would clutter the
    // collection with one row per tick forever. Just no-op silently.
    return;
  }

  // 1. Resume any in-flight cycle first. A crash mid-broadcast must be
  // recovered before we consider starting a new one, otherwise we could
  // miss payouts on the prior pool snapshot.
  const resumable = await claimResumableCycle();
  if (resumable) {
    logger.info(
      {
        cycleId: resumable._id.toString(),
        pendingPayouts: resumable.payouts.filter((p) => p.status === "PENDING")
          .length,
      },
      "masternode reward worker: resuming in-flight cycle",
    );
    await executeCycle(resumable);
    return;
  }

  // 2. Cadence gate. If a cycle (any status) was triggered within the last
  // INTERVAL_MS, skip — this happens on process restart inside the
  // interval window.
  const cutoff = new Date(
    Date.now() - config.MASTERNODE_REWARDS_INTERVAL_MS,
  );
  if (await hasRecentCycle(cutoff)) {
    return;
  }

  // 3. Read pool balance & masternode list.
  const [poolSats, mnList] = await Promise.all([
    readPoolBalanceSats(),
    getMasternodeList(),
  ]);
  const eligible = mnList.filter(isEligible);

  // 4. Skip-cycle paths. Each emits a SKIPPED row + audit-log entry so the
  // operator can see the worker is alive and why it didn't pay out.
  const minBalanceSats = fairToSats(
    config.MASTERNODE_REWARDS_MIN_BALANCE_FAIR,
  );
  if (poolSats < minBalanceSats) {
    await recordSkip("SKIPPED_BELOW_THRESHOLD", {
      poolBalanceSats: poolSats,
      activeMasternodes: eligible.length,
    });
    return;
  }
  if (eligible.length === 0) {
    await recordSkip("SKIPPED_NO_MASTERNODES", {
      poolBalanceSats: poolSats,
      activeMasternodes: 0,
    });
    return;
  }

  // 5. Compute per-masternode amount with fee budget.
  const perMasternodeSats = computePerMasternodeSats(
    poolSats,
    eligible.length,
    config.MASTERNODE_REWARDS_PAYOUT_FEE_FAIR,
  );
  if (perMasternodeSats <= 0n) {
    await recordSkip("SKIPPED_BELOW_THRESHOLD", {
      poolBalanceSats: poolSats,
      activeMasternodes: eligible.length,
      perMasternodeSats,
    });
    return;
  }

  // 6. Persist a fresh cycle and execute. Insertion + execution are
  // separate steps so a crash between them leaves the cycle in PENDING
  // for the next tick to claim.
  const cycle = await MasternodeRewardCycle.create({
    triggeredAt: new Date(),
    poolBalanceFair: poolSats.toString(),
    activeMasternodes: eligible.length,
    perMasternodeFair: perMasternodeSats.toString(),
    payouts: buildPayouts(eligible, perMasternodeSats),
    status: "PAYING_OUT",
  });
  logger.info(
    {
      cycleId: cycle._id.toString(),
      poolSats: poolSats.toString(),
      activeMasternodes: eligible.length,
      perMasternodeSats: perMasternodeSats.toString(),
    },
    "masternode reward worker: starting payout cycle",
  );
  // Re-fetch as a lean doc so executeCycle has consistent read shape.
  const lean = await MasternodeRewardCycle.findById(cycle._id).lean<
    MasternodeRewardCycleDoc | null
  >();
  if (!lean) return;
  await executeCycle(lean);
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

/**
 * Long-running worker loop. Resolves once `signal` is aborted. Errors
 * inside a tick are logged and alerted; the loop keeps running so a
 * transient RPC outage does not silently kill the booster.
 *
 * The cadence is `MASTERNODE_REWARDS_INTERVAL_MS` between ticks. This is
 * intentionally the same as the operator-visible "weekly distribution"
 * cadence — there is no point waking up more often, since the cadence gate
 * inside `runMasternodeRewardTick` would just no-op.
 */
export async function startMasternodeRewardWorker(
  signal: AbortSignal,
): Promise<void> {
  if (!config.MASTERNODE_REWARDS_ENABLED) {
    logger.info("masternode reward worker disabled (MASTERNODE_REWARDS_ENABLED=false)");
    return;
  }
  logger.info(
    {
      intervalMs: config.MASTERNODE_REWARDS_INTERVAL_MS,
      minBalanceFair: config.MASTERNODE_REWARDS_MIN_BALANCE_FAIR,
      payoutFeeFair: config.MASTERNODE_REWARDS_PAYOUT_FEE_FAIR,
      poolAddress: config.FAIR_MASTERNODE_REWARD_ADDRESS ?? "<unset>",
    },
    "masternode reward worker starting",
  );
  while (!signal.aborted) {
    try {
      await runMasternodeRewardTick();
    } catch (err: unknown) {
      logger.error({ err }, "masternode reward worker tick error");
      await alert("masternode reward worker tick error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(config.MASTERNODE_REWARDS_INTERVAL_MS, signal);
  }
  logger.info("masternode reward worker stopped");
}

// Internal helpers exported for unit tests. NOT part of the public surface;
// downstream code should import the worker entrypoint above.
export const __test__ = {
  computePerMasternodeSats,
  fairToSats,
  satsToFair,
  isEligible,
  outpointKey,
  buildPayouts,
};
