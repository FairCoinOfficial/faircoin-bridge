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

// FaircoinRpcClient mock is installed globally by test/mock-fair-rpc.ts.
// We register a handler that COUNTS any RPC call so the assertions below
// can verify the disabled flag short-circuits before the worker reaches
// any wire call.
import { setRpcHandler, clearRpcHandler } from "./mock-fair-rpc.js";

setRpcHandler((method, params) => {
  if (method === "getreceivedbyaddress") {
    calls.getReceivedByAddress += 1;
    return Promise.resolve(0);
  }
  if (method === "masternodelist") {
    calls.getMasternodeList += 1;
    return Promise.resolve([]);
  }
  if (method === "sendtoaddress") {
    const address = params[0];
    const amount = params[1];
    if (typeof address !== "string" || typeof amount !== "number") {
      return Promise.reject(new Error("sendtoaddress mock: bad params"));
    }
    calls.sends.push({ address, amountFair: amount });
    return Promise.resolve("txid_should_never_happen");
  }
  return Promise.reject(
    new Error(`disabled-test mock: unexpected RPC method ${method}`),
  );
});

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
  // Restore the spy mocks (audit-log, alert, logger, config). The shared
  // FaircoinRpcClient handler is cleared so a later test file can install
  // its own without inheriting our counter side-effects.
  clearRpcHandler();
  mock.restore();
});
