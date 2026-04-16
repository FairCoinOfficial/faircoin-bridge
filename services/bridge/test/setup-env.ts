/**
 * Minimal env required by `src/config.ts` so test modules that transitively
 * import config can be loaded without a real .env file. Imported as the very
 * first thing in each test file before any other imports execute.
 */
const defaults: Record<string, string> = {
  FAIR_NETWORK: "testnet",
  FAIR_RPC_URL: "http://127.0.0.1:46375",
  BASE_NETWORK: "sepolia",
  BASE_RPC_URL: "http://127.0.0.1:8545",
  WFAIR_CONTRACT_ADDRESS: "0xF2853CedDF47A05Fee0B4b24DFf2925d59737fb3",
  SAFE_ADDRESS: "0xee8b8B9B7CFF6cDb51DA8f92a511005859007521",
  SAFE_TX_SERVICE_URL: "https://safe-transaction-base.safe.global",
  MONGO_URI: "mongodb://127.0.0.1:27017/faircoin-bridge-test",
  REDIS_URL: "redis://127.0.0.1:6379/15",
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  MIN_DEPOSIT_FAIR: "1",
  MAX_TVL_FAIR: "1000000",
  PER_ADDRESS_DAILY_CAP_FAIR: "1000000",
  BRIDGE_FEE_BPS: "0",
  FAIR_CONFIRMATIONS: "1",
  BASE_CONFIRMATIONS: "1",
};
for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}
