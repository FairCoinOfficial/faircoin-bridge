// Isolated test for the MASTERNODE_REWARDS_ENABLED=false short-circuit.
//
// Bun's test runner shares the module cache across test files in a single
// run, so toggling `process.env.MASTERNODE_REWARDS_ENABLED` after config.ts
// has already loaded would have no effect. We instead mock the config module
// directly so the worker's `if (!config.MASTERNODE_REWARDS_ENABLED)` guard
// sees `false` regardless of which test file ran first.

import "./setup-env.js";

import { afterAll, describe, expect, it, mock } from "bun:test";

interface SendCall { address: string; amountFair: number }

const calls = {
  cycleCreate: 0,
  getReceivedByAddress: 0,
  getMasternodeList: 0,
  sends: [] as SendCall[],
};

// Override only the masternode-reward fields. Bun's mock cache is
// process-wide, so any field we don't include here would surface as
// `undefined` to OTHER test files (signer-fair.test.ts depends on
// FAIR_HOT_WALLET_MODE, etc.). We import the real config and spread it.
const { config: realConfig } = await import("../src/config.js");
mock.module("../src/config.js", () => ({
  config: {
    ...realConfig,
    MASTERNODE_REWARDS_ENABLED: false,
    FAIR_MASTERNODE_REWARD_ADDRESS: undefined,
  },
}));

mock.module("../src/models/masternode-reward-cycle.js", () => ({
  MasternodeRewardCycle: {
    create: async () => {
      calls.cycleCreate += 1;
      return {};
    },
    findOneAndUpdate: () => ({ lean: async () => null }),
    findOne: () => ({ select: () => ({ lean: async () => null }), lean: async () => null }),
    findById: () => ({ lean: async () => null }),
    updateOne: async () => ({ acknowledged: true }),
  },
  MASTERNODE_REWARD_CYCLE_STATUSES: [],
  MASTERNODE_PAYOUT_STATUSES: [],
}));

mock.module("../src/models/audit-log.js", () => ({
  AuditLog: { create: async () => ({}) },
}));

mock.module("../src/lib/alert.js", () => ({ alert: async () => undefined }));

mock.module("../src/lib/logger.js", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
  },
}));

// Full fair.js surface — see masternode-reward-worker.test.ts for the
// rationale (bun's mock cache is shared across test files).
mock.module("../src/rpc/fair.js", () => ({
  getReceivedByAddressSats: async () => {
    calls.getReceivedByAddress += 1;
    return 0n;
  },
  getMasternodeList: async () => {
    calls.getMasternodeList += 1;
    return [];
  },
  sendToAddress: async (address: string, amountFair: number) => {
    calls.sends.push({ address, amountFair });
    return "txid_should_never_happen";
  },
  getRawTransaction: async () => ({ txid: "x" }),
  validateAddress: async () => ({ isvalid: true }),
  getTipHeight: async () => 0,
  getBlockAtHeight: async () => {
    throw new Error("getBlockAtHeight not implemented in disabled test");
  },
  getBlockWithTxs: async () => {
    throw new Error("getBlockWithTxs not implemented in disabled test");
  },
  sendRawTransaction: async () => "",
  getWalletBalanceSats: async () => 0n,
  fairRpc: { call: async () => undefined },
}));

const { runMasternodeRewardTick } = await import(
  "../src/workers/masternode-reward-worker.js"
);

describe("runMasternodeRewardTick — disabled flag", () => {
  it("returns immediately, performs no RPC and writes no cycle row", async () => {
    await runMasternodeRewardTick();
    expect(calls.cycleCreate).toBe(0);
    expect(calls.getReceivedByAddress).toBe(0);
    expect(calls.getMasternodeList).toBe(0);
    expect(calls.sends).toHaveLength(0);
  });
});

afterAll(() => {
  // See the equivalent note in masternode-reward-worker.test.ts: restore the
  // global mock registry so downstream test files see the real implementations.
  mock.restore();
});
