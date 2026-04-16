import { z } from "zod";
import { logger } from "./lib/logger.js";

const EthAddressRegex = /^0x[0-9a-fA-F]{40}$/;
const HexPrivKeyRegex = /^0x[0-9a-fA-F]{64}$/;

const OptionalString = z
  .string()
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional();

const OptionalUrl = z
  .string()
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional()
  .refine((v) => v === undefined || /^https?:\/\//.test(v), {
    message: "must be a URL or empty",
  });

const ConfigSchema = z.object({
  // FairCoin RPC
  FAIR_NETWORK: z.enum(["testnet", "mainnet"]),
  FAIR_RPC_URL: z.string().url(),
  FAIR_RPC_USER: OptionalString,
  FAIR_RPC_PASSWORD: OptionalString,

  // Base
  BASE_NETWORK: z.enum(["sepolia", "mainnet"]),
  BASE_RPC_URL: z.string().url(),
  BASE_RPC_URL_FALLBACK: OptionalUrl,
  WFAIR_CONTRACT_ADDRESS: z.string().regex(EthAddressRegex),
  SAFE_ADDRESS: z.string().regex(EthAddressRegex),
  SAFE_TX_SERVICE_URL: z.string().url(),

  // Signers (dev-optional)
  BRIDGE_EOA_PRIVATE_KEY: z
    .string()
    .regex(HexPrivKeyRegex)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  FAIR_HOT_WALLET_XPRV: OptionalString,
  FAIR_BRIDGE_XPUB: OptionalString,
  FAIR_DEPOSIT_DERIVATION_PATH: z.string().default("m/44'/119'/0'/0"),

  // Signing modes
  // direct_eoa: bridge EOA holds MINTER_ROLE on WFAIR and mints directly (fast, requires EOA role grant)
  // safe_proposal: worker proposes a Safe tx; 2nd signer + execution happen out-of-band via Safe UI
  MINT_AUTH_MODE: z.enum(["direct_eoa", "safe_proposal"]).default("direct_eoa"),
  // node_wallet: use faircoind listunspent/sendtoaddress (fastest to ship, requires configured node wallet)
  // local_hd: build + sign txs locally from FAIR_HOT_WALLET_XPRV (phase 2)
  FAIR_HOT_WALLET_MODE: z
    .enum(["node_wallet", "local_hd"])
    .default("node_wallet"),

  // Storage
  MONGO_URI: z.string().url(),
  REDIS_URL: z.string().url(),

  // Policy
  MAX_TVL_FAIR: z.coerce.number().default(1000),
  MIN_DEPOSIT_FAIR: z.coerce.number().default(10),
  BRIDGE_FEE_BPS: z.coerce.number().default(30),
  FAIR_CONFIRMATIONS: z.coerce.number().default(6),
  BASE_CONFIRMATIONS: z.coerce.number().default(20),
  PER_ADDRESS_DAILY_CAP_FAIR: z.coerce.number().default(100),

  // Alerting
  DISCORD_WEBHOOK_URL: OptionalUrl,

  // ─── Buy-FAIR flow ─────────────────────────────────────────────────────
  // Bridge-controlled HD root (Ethereum cointype 60) used to allocate fresh
  // payment addresses per buy order. Either an xprv or a mnemonic must be set
  // to enable the Buy endpoints.
  BUY_PAYMENT_HD_XPRV: OptionalString,
  BUY_PAYMENT_HD_MNEMONIC: OptionalString,

  // USDC contract on Base mainnet (token0 of the WFAIR/USDC pool).
  // Override only on testnets.
  USDC_BASE_ADDRESS: z
    .string()
    .regex(EthAddressRegex)
    .default("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),

  // Live WFAIR/USDC v3 pool on Base mainnet (3000 fee tier).
  WFAIR_USDC_POOL_ADDRESS: z
    .string()
    .regex(EthAddressRegex)
    .default("0x9F4F694390c60b51e30461c785C1345A1545b7ca"),

  // Uniswap v3 Quoter & SwapRouter02 on Base mainnet.
  UNISWAP_V3_QUOTER: z
    .string()
    .regex(EthAddressRegex)
    .default("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"),
  UNISWAP_V3_SWAP_ROUTER: z
    .string()
    .regex(EthAddressRegex)
    .default("0x2626664c2603336E57B271c5C0b26F421741e481"),

  // Default slippage buffer (bps) added on top of pool quote when computing
  // the user-facing payment amount. 200 bps = 2%.
  BUY_SLIPPAGE_BUFFER_BPS: z.coerce.number().default(200),
  // Bridge fee taken on each buy (bps). Independent of BRIDGE_FEE_BPS used
  // for deposit/withdraw flows.
  BUY_BRIDGE_FEE_BPS: z.coerce.number().default(100),
  // Minimum FAIR per buy order (whole FAIR units).
  BUY_MIN_FAIR: z.coerce.number().default(1),
  // Maximum FAIR per buy order.
  BUY_MAX_FAIR: z.coerce.number().default(1000),
  // Lifetime of a quote in seconds.
  BUY_QUOTE_TTL_SECONDS: z.coerce.number().default(900),

  // Card-payment provider config. When unset, the API exposes the CARD
  // option as "coming soon" and does not return a cardPaymentUrl.
  MOONPAY_API_KEY: OptionalString,
  TRANSAK_API_KEY: OptionalString,

  // API
  PORT: z.coerce.number().default(3100),
  API_CORS_ORIGIN: OptionalString,

  // Runtime
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues },
      "invalid environment configuration",
    );
    process.exit(1);
  }
  return parsed.data;
}

export const config: Config = loadConfig();
