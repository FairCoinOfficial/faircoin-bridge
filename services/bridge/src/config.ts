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
