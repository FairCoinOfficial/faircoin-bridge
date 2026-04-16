// Shared mock for `@fairco.in/rpc-client` used by every test file that needs
// to control the FaircoinRpcClient. See the long comment below for why a
// single shared mock is necessary instead of per-file mocks.
//
// Background: `src/rpc/fair.ts` imports `FaircoinRpcClient` at module load
// and instantiates a singleton `fairRpc`. Bun's test runner caches both the
// `@fairco.in/rpc-client` module AND `src/rpc/fair.ts` across files. Once
// the FIRST test file mocks `@fairco.in/rpc-client` with class A, fair.ts is
// bound to class A; any LATER test file that re-mocks with class B is
// silently ignored — fair.ts still holds the original Inner reference.
//
// To work around this, we install ONE mock class globally (whichever file
// imports this helper first does the registration), and route all dispatch
// through a runtime-mutable handler. Each test file calls
// `setRpcHandler(...)` in its `beforeEach` to install the behaviour it needs
// for that test, and the same class instance routes the call accordingly.

import { mock } from "bun:test";

export type RpcHandler = (
  method: string,
  params: readonly unknown[],
) => Promise<unknown>;

/**
 * The default handler is loud: any unmocked test file that triggers an RPC
 * call without first installing a handler will get a clear error rather than
 * a silent stub. Tests opt in to specific behaviour via `setRpcHandler`.
 */
function defaultHandler(method: string): Promise<unknown> {
  return Promise.reject(
    new Error(
      `mock FaircoinRpcClient: no handler installed for method ${method}. ` +
        `Call setRpcHandler(...) in your test's beforeEach.`,
    ),
  );
}

let currentHandler: RpcHandler = defaultHandler;

export function setRpcHandler(handler: RpcHandler): void {
  currentHandler = handler;
}

export function clearRpcHandler(): void {
  currentHandler = defaultHandler;
}

mock.module("@fairco.in/rpc-client", () => {
  class FaircoinRpcClient {
    constructor(_options: unknown) {
      // no-op: configuration is irrelevant — every call is handled by the
      // installed handler in this module's closure.
    }
    async call<T>(
      method: string,
      params: readonly unknown[] = [],
    ): Promise<T> {
      const result = await currentHandler(method, params);
      return result as T;
    }
  }
  return { FaircoinRpcClient };
});
