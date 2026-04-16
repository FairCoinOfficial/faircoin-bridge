import { z } from "zod";
import { logger } from "./lib/logger.js";

const EthAddressRegex = /^0x[0-9a-fA-F]{40}$/;
const HexPrivKeyRegex = /^0x[0-9a-fA-F]{64}$/;
// FairCoin Base58Check addresses on mainnet start with 'F' (PUBKEY_ADDRESS
// = 35) or '3' (SCRIPT_ADDRESS = 16); testnet uses 'T' (65) or '5' (12). The
// buy-back/burn worker accepts any of these as a destination since all are
// valid funds-receivable address types. Final validation happens via
// `validateaddress` against the configured faircoind node before sending.
const FairAddressRegex = /^[FT35][a-km-zA-HJ-NP-Z1-9]{20,63}$/;

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

const ConfigSchemaBase = z.object({
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

  // ─── Buy-back / treasury distribution ─────────────────────────────────
  // Periodic worker that drains accumulated USDC fees from the bridge admin
  // EOA into WFAIR via Uniswap, then bridgeBurns the proceeds split across
  // three FAIR destinations. See src/workers/buyback-worker.ts.
  BUYBACK_ENABLED: z
    .union([z.literal("true"), z.literal("false"), z.literal("")])
    .default("false")
    .transform((v) => v === "true"),
  BUYBACK_THRESHOLD_USDC: z.coerce.number().min(1).default(100),
  BUYBACK_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  BUYBACK_BURN_BPS: z.coerce.number().int().min(0).max(10_000).default(5_000),
  BUYBACK_TREASURY_BPS: z.coerce.number().int().min(0).max(10_000).default(3_000),
  BUYBACK_MASTERNODE_BPS: z.coerce.number().int().min(0).max(10_000).default(2_000),
  // FAIR addresses are only structurally validated here; live validation
  // against faircoind happens on worker boot and on each cycle.
  FAIR_BURN_ADDRESS: z
    .string()
    .regex(FairAddressRegex)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  FAIR_TREASURY_ADDRESS: z
    .string()
    .regex(FairAddressRegex)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  FAIR_MASTERNODE_REWARD_ADDRESS: z
    .string()
    .regex(FairAddressRegex)
    .optional()
    .or(z.literal("").transform(() => undefined)),

  // ─── Masternode reward booster (task #29) ─────────────────────────────
  // Periodic worker that drains FAIR_MASTERNODE_REWARD_ADDRESS pro-rata
  // across all ENABLED FairCoin masternodes via faircoind sendtoaddress. The
  // funding side lives in the buy-back worker (BUYBACK_MASTERNODE_BPS slice).
  // Disabled by default; must be explicitly switched on by the operator.
  MASTERNODE_REWARDS_ENABLED: z
    .union([z.literal("true"), z.literal("false"), z.literal("")])
    .default("false")
    .transform((v) => v === "true"),
  // Cadence between distribution attempts. Default: weekly (1000 * 60 * 60 *
  // 24 * 7). Minimum 1 minute to avoid stampeding the wallet on misconfig.
  MASTERNODE_REWARDS_INTERVAL_MS: z
    .coerce.number()
    .int()
    .min(60_000)
    .default(604_800_000),
  // Below this many FAIR (whole units) sitting in the reward pool, skip the
  // cycle and try again next tick. Avoids dust-only payouts that get eaten by
  // the per-payout tx fee.
  MASTERNODE_REWARDS_MIN_BALANCE_FAIR: z.coerce.number().min(0).default(10),
  // Reserved on-chain fee per outbound sendtoaddress. Subtracted (× #payouts)
  // from the distributable balance so the wallet is never asked to spend more
  // than it has after fees. faircoind currently relies on its `mintxfee`/
  // `paytxfee` config knobs; this value is a budget cap, not a wire-level
  // override.
  MASTERNODE_REWARDS_PAYOUT_FEE_FAIR: z.coerce
    .number()
    .min(0)
    .default(0.001),

  // Bearer token for the admin API (buyback trigger / status). Leave blank
  // to disable the admin router entirely.
  ADMIN_API_TOKEN: OptionalString,

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

const ConfigSchema = ConfigSchemaBase.superRefine((cfg, ctx) => {
  // Enforce BPS sum exactly == 10000 so the buy-back distribution is total.
  // Allowing slack would silently leak WFAIR back into the bridge EOA across
  // cycles, breaking the deflationary invariant.
  const bpsSum =
    cfg.BUYBACK_BURN_BPS +
    cfg.BUYBACK_TREASURY_BPS +
    cfg.BUYBACK_MASTERNODE_BPS;
  if (bpsSum !== 10_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [
        "BUYBACK_BURN_BPS",
        "BUYBACK_TREASURY_BPS",
        "BUYBACK_MASTERNODE_BPS",
      ],
      message: `BUYBACK_*_BPS must sum to 10000, got ${String(bpsSum)}`,
    });
  }
  // Treasury + masternode addresses are only required when the worker is
  // enabled. The burn address has a canonical default derived in
  // src/lib/burn-address.ts, so we don't require it here even when enabled.
  if (cfg.BUYBACK_ENABLED) {
    if (!cfg.FAIR_TREASURY_ADDRESS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FAIR_TREASURY_ADDRESS"],
        message:
          "FAIR_TREASURY_ADDRESS is required when BUYBACK_ENABLED=true",
      });
    }
    if (!cfg.FAIR_MASTERNODE_REWARD_ADDRESS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FAIR_MASTERNODE_REWARD_ADDRESS"],
        message:
          "FAIR_MASTERNODE_REWARD_ADDRESS is required when BUYBACK_ENABLED=true",
      });
    }
  }
  // The masternode-reward booster reads the pool balance from
  // FAIR_MASTERNODE_REWARD_ADDRESS via getreceivedbyaddress, so the address
  // is mandatory when the worker is enabled even if the buy-back side is
  // off. (Operator may pre-fund the pool manually before turning on
  // buy-back.)
  if (cfg.MASTERNODE_REWARDS_ENABLED && !cfg.FAIR_MASTERNODE_REWARD_ADDRESS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["FAIR_MASTERNODE_REWARD_ADDRESS"],
      message:
        "FAIR_MASTERNODE_REWARD_ADDRESS is required when MASTERNODE_REWARDS_ENABLED=true",
    });
  }
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
