/**
 * One-shot script: mint 5,000 WFAIR to admin, then create + seed a Uniswap v3
 * WFAIR/USDC pool on Base mainnet with single-sided WFAIR liquidity.
 *
 * Range: $0.50 → $2.00 (price = WFAIR in USDC).
 * Founder-funded: no USDC put up. As price moves up through the range, buyers'
 * USDC accumulates in the position.
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { encodeSqrtRatioX96, TickMath } from "@uniswap/v3-sdk";
import JSBI from "jsbi";

// ─── constants ──────────────────────────────────────────────────────────────
const WALLET_FILE = "/home/nate/.faircoin-bridge-mainnet-wallet.txt";
const RPC_URL =
  "https://base-mainnet.g.alchemy.com/v2/ptAY7QzugU6HCSXutKmK7";

const WFAIR_ADDRESS: Address = "0xF2853CedDF47A05Fee0B4b24DFf2925d59737fb3";
const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ADMIN_ADDRESS: Address = "0xee8b8B9B7CFF6cDb51DA8f92a511005859007521";
const NPM_ADDRESS: Address = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";
const FACTORY_ADDRESS: Address = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";

const FEE_TIER = 3000; // 0.3% fee tier
const TICK_SPACING = 60;
const SEED_AMOUNT_WFAIR_RAW = 5000n * 10n ** 18n; // 5000 WFAIR (18 decimals)
const USDC_DECIMALS = 6;
const WFAIR_DECIMALS = 18;

// ─── ABIs (minimal, hand-written, fully typed) ──────────────────────────────
const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const factoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const poolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "liquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "fee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint24" }],
  },
  {
    type: "function",
    name: "tickSpacing",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
  },
] as const;

const npmAbi = [
  {
    type: "function",
    name: "createAndInitializePoolIfNecessary",
    stateMutability: "payable",
    inputs: [
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "sqrtPriceX96", type: "uint160" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "IncreaseLiquidity",
    anonymous: false,
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

// ─── helpers ────────────────────────────────────────────────────────────────
function loadPrivateKey(): Hex {
  const text = readFileSync(WALLET_FILE, "utf8");
  const match = text.match(/Private key:\s*(0x[a-fA-F0-9]+)/);
  if (!match || !match[1]) {
    throw new Error(`Could not extract private key from ${WALLET_FILE}`);
  }
  const pk = match[1].toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(pk)) {
    throw new Error(`Invalid private key format in ${WALLET_FILE}`);
  }
  return pk as Hex;
}

function jsbiToBigInt(v: JSBI): bigint {
  return BigInt(v.toString());
}

function fmtUsdcRawToHuman(raw: bigint): string {
  const integer = raw / 10n ** BigInt(USDC_DECIMALS);
  const frac = raw % 10n ** BigInt(USDC_DECIMALS);
  return `${integer}.${frac.toString().padStart(USDC_DECIMALS, "0")}`;
}

function fmtWfairRawToHuman(raw: bigint): string {
  const integer = raw / 10n ** BigInt(WFAIR_DECIMALS);
  const frac = raw % 10n ** BigInt(WFAIR_DECIMALS);
  return `${integer}.${frac.toString().padStart(WFAIR_DECIMALS, "0")}`;
}

/**
 * Convert a price in USD-per-WFAIR into the Uniswap "price = token1/token0"
 * raw ratio. With token0 = USDC (6 dec) and token1 = WFAIR (18 dec):
 *   1 WFAIR = priceUsd USDC
 *   ⇒ 1e18 raw WFAIR = priceUsd * 1e6 raw USDC
 *   ⇒ 1 raw USDC = 1e18 / (priceUsd * 1e6) raw WFAIR
 *   ⇒ token1/token0 ratio = 1e18 / (priceUsd * 1e6)
 *
 * To preserve precision without floats we scale priceUsd by 1e8 so we work
 * entirely in BigInt:
 *   amount1 / amount0 = 1e18 * 1e8 / (priceUsd_scaled * 1e6)
 *                     = 1e20 / priceUsd_scaled
 * Multiply numerator and denominator by 1e6 to keep amount0 integer-friendly.
 */
function priceUsdToSqrtX96(priceUsdTimes1e8: bigint): bigint {
  // amount1 = 1e18 * 1e8 = 1e26 (raw WFAIR per unit price-scaled)
  // amount0 = priceUsdTimes1e8 * 1e6 (raw USDC per unit price-scaled)
  const amount1 = 10n ** 26n;
  const amount0 = priceUsdTimes1e8 * 10n ** 6n;
  const sqrt = encodeSqrtRatioX96(amount1.toString(), amount0.toString());
  return jsbiToBigInt(sqrt);
}

function tickAtPriceUsd(priceUsdTimes1e8: bigint): number {
  const sqrtX96 = priceUsdTimes1e8ToSqrtJsbi(priceUsdTimes1e8);
  return TickMath.getTickAtSqrtRatio(sqrtX96);
}

function priceUsdTimes1e8ToSqrtJsbi(priceUsdTimes1e8: bigint): JSBI {
  const amount1 = 10n ** 26n;
  const amount0 = priceUsdTimes1e8 * 10n ** 6n;
  return encodeSqrtRatioX96(amount1.toString(), amount0.toString());
}

function snapTickUpToSpacing(tick: number, spacing: number): number {
  const remainder = ((tick % spacing) + spacing) % spacing;
  if (remainder === 0) return tick + spacing; // strictly above
  return tick + (spacing - remainder);
}

function snapTickDownToSpacing(tick: number, spacing: number): number {
  const remainder = ((tick % spacing) + spacing) % spacing;
  return tick - remainder;
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("WFAIR/USDC v3 pool seed — Base mainnet");
  console.log("=".repeat(72));

  // Sort tokens (lowercase hex compare)
  const usdcLc = USDC_ADDRESS.toLowerCase();
  const wfairLc = WFAIR_ADDRESS.toLowerCase();
  if (usdcLc >= wfairLc) {
    throw new Error(
      `Token sort error: expected USDC < WFAIR. usdc=${usdcLc} wfair=${wfairLc}`,
    );
  }
  const token0: Address = USDC_ADDRESS;
  const token1: Address = WFAIR_ADDRESS;
  console.log(`token0 (USDC ): ${token0}`);
  console.log(`token1 (WFAIR): ${token1}`);

  // ─── price → tick reasoning ─────────────────────────────────────────────
  // Pool internal "price" (the token1/token0 raw ratio) = WFAIR_raw / USDC_raw.
  //   - At $0.50 USD/WFAIR: 1 WFAIR = 0.5 USDC → 1e18 raw WFAIR = 5e5 raw USDC
  //     → raw_price = 1e18 / 5e5 = 2e12 (HIGH raw price = LOW USD price)
  //   - At $2.00 USD/WFAIR: 1 WFAIR = 2 USDC → raw_price = 5e11 (LOW raw)
  // tick = floor(log_1.0001(raw_price)). So tick INCREASES as USD price goes
  // DOWN, and DECREASES as USD price goes UP. Therefore:
  //   - tickLower (lowest raw price in range) corresponds to the HIGHEST USD
  //     price ($2.00).
  //   - tickUpper (highest raw price in range) corresponds to the LOWEST USD
  //     price ($0.50).
  //
  // Uniswap v3 single-sided rule: for a position [tickLower, tickUpper] with
  // pool currentTick, the position holds:
  //   - only token0 if currentTick < tickLower
  //   - only token1 if currentTick >= tickUpper
  //   - both if tickLower <= currentTick < tickUpper
  // We want only token1 (WFAIR), so currentTick must be >= tickUpper.
  // Equivalent in USD: pool init USD price must be ≤ range low ($0.50).
  // We pick $0.49 (slightly below) so the position is unambiguously WFAIR-only.
  const PRICE_INIT_E8 = 49_000_000n; // $0.49 USD/WFAIR
  const PRICE_RANGE_LOW_USD_E8 = 50_000_000n; // $0.50
  const PRICE_RANGE_HIGH_USD_E8 = 200_000_000n; // $2.00

  const sqrtPriceX96Init = priceUsdToSqrtX96(PRICE_INIT_E8);
  const tickInit = tickAtPriceUsd(PRICE_INIT_E8);
  const tickAtRangeLowUsd = tickAtPriceUsd(PRICE_RANGE_LOW_USD_E8);
  const tickAtRangeHighUsd = tickAtPriceUsd(PRICE_RANGE_HIGH_USD_E8);

  // In pool tick coords:
  //   tickAtRangeHighUsd ($2.00) = lower tick value = position's tickLower
  //   tickAtRangeLowUsd  ($0.50) = higher tick value = position's tickUpper
  // Snap tickLower DOWN to widen the range outward to lower USD price (≤ $2).
  // Snap tickUpper UP   to widen the range outward to higher USD price (≥ $0.50).
  // Wait — outward widening means tickLower further DOWN (lower raw price =
  // higher USD price, > $2) and tickUpper further UP (higher raw price = lower
  // USD price, < $0.50). To stay within the spec's intent ($0.50 → $2.00),
  // snap INWARD instead: tickLower UP (raises the lower bound of raw price =
  // lowers the upper bound of USD = capping at ≤ $2.00 effectively),
  // tickUpper DOWN (caps the upper bound of raw price = raises the lower
  // bound of USD = ≥ $0.50). That is too restrictive.
  //
  // The cleanest is: snap each boundary to the NEAREST tick spacing that
  // keeps the range EXACTLY the requested USD bounds (or as close as possible)
  // and ensure currentTick >= tickUpper. We use:
  //   tickLower = snapDown(tickAtRangeHighUsd)  → range extends slightly
  //                                                ABOVE $2 (slightly wider)
  //   tickUpper = snapUp(tickAtRangeLowUsd)     → range extends slightly
  //                                                BELOW $0.50 (slightly wider)
  // Both widen the range to nearest tick spacing, which is the standard
  // approach. Then verify currentTick >= tickUpper for single-sided.
  const tickLower = snapTickDownToSpacing(tickAtRangeHighUsd, TICK_SPACING);
  const tickUpper = snapTickUpToSpacing(tickAtRangeLowUsd, TICK_SPACING);

  console.log("");
  console.log("price/tick math (token0=USDC, token1=WFAIR):");
  console.log(`  pool init price   $0.49 USD/WFAIR  → tick ${tickInit}`);
  console.log(`  range low (USD)   $0.50 USD/WFAIR  → tick ${tickAtRangeLowUsd}`);
  console.log(`  range high (USD)  $2.00 USD/WFAIR  → tick ${tickAtRangeHighUsd}`);
  console.log(`  position tickLower (snap-down ${tickAtRangeHighUsd}) = ${tickLower}`);
  console.log(`  position tickUpper (snap-up   ${tickAtRangeLowUsd})  = ${tickUpper}`);
  console.log(`  init sqrtPriceX96 = ${sqrtPriceX96Init}`);

  if (tickUpper <= tickLower) {
    throw new Error(`tickUpper (${tickUpper}) must be > tickLower (${tickLower})`);
  }
  if (tickInit < tickUpper) {
    throw new Error(
      `pool initial tick (${tickInit}) must be >= tickUpper (${tickUpper}) for single-sided WFAIR (token1) liquidity`,
    );
  }
  if (tickLower % TICK_SPACING !== 0 || tickUpper % TICK_SPACING !== 0) {
    throw new Error(`ticks must be multiples of ${TICK_SPACING}`);
  }

  if (process.env.DRY_RUN === "1") {
    console.log("");
    console.log("DRY_RUN=1 set — exiting before any RPC / tx work.");
    return;
  }

  // ── viem clients ─────────────────────────────────────────────────────────
  const account = privateKeyToAccount(loadPrivateKey());
  if (account.address.toLowerCase() !== ADMIN_ADDRESS.toLowerCase()) {
    throw new Error(
      `wallet address mismatch: derived=${account.address} expected=${ADMIN_ADDRESS}`,
    );
  }
  console.log("");
  console.log(`signer: ${account.address}`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL),
  });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });

  // Sanity-check USDC + WFAIR
  const [usdcSymbol, usdcDec, wfairSymbol, wfairDec] = await Promise.all([
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    publicClient.readContract({
      address: WFAIR_ADDRESS,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    publicClient.readContract({
      address: WFAIR_ADDRESS,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);
  console.log(`USDC: symbol=${usdcSymbol} decimals=${usdcDec}`);
  console.log(`WFAIR: symbol=${wfairSymbol} decimals=${wfairDec}`);
  if (usdcDec !== USDC_DECIMALS) {
    throw new Error(`unexpected USDC decimals: ${usdcDec}`);
  }
  if (wfairDec !== WFAIR_DECIMALS) {
    throw new Error(`unexpected WFAIR decimals: ${wfairDec}`);
  }

  // Pre-state
  const [
    wfairTotalSupplyBefore,
    adminWfairBefore,
    adminEthBalance,
    existingPool,
  ] = await Promise.all([
    publicClient.readContract({
      address: WFAIR_ADDRESS,
      abi: erc20Abi,
      functionName: "totalSupply",
    }),
    publicClient.readContract({
      address: WFAIR_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [ADMIN_ADDRESS],
    }),
    publicClient.getBalance({ address: ADMIN_ADDRESS }),
    publicClient.readContract({
      address: FACTORY_ADDRESS,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token0, token1, FEE_TIER],
    }),
  ]);
  console.log("");
  console.log("pre-state:");
  console.log(`  WFAIR.totalSupply  = ${wfairTotalSupplyBefore} (= ${fmtWfairRawToHuman(wfairTotalSupplyBefore)} WFAIR)`);
  console.log(`  admin WFAIR        = ${adminWfairBefore} (= ${fmtWfairRawToHuman(adminWfairBefore)} WFAIR)`);
  console.log(`  admin ETH (Base)   = ${adminEthBalance} wei (= ${Number(adminEthBalance) / 1e18} ETH)`);
  console.log(`  factory.getPool    = ${existingPool} (zero = pool not yet created)`);

  // At current Base gas (~0.006 gwei), the full run costs ~4e13 wei. We
  // require 10x that as a buffer: 4e14 wei = 0.0004 ETH.
  const MIN_ETH_WEI = 400_000_000_000_000n;
  if (adminEthBalance < MIN_ETH_WEI) {
    throw new Error(
      `admin ETH balance too low (${adminEthBalance} wei = ${Number(adminEthBalance) / 1e18} ETH) — need at least ${MIN_ETH_WEI} wei for gas`,
    );
  }

  // Track total gas spent for final report
  let totalGasUsed = 0n;
  let totalGasPriceWeightedWei = 0n;
  // Tx hashes for the final report — null when a step is skipped (idempotent).
  let mintTxRecorded: Hex | null = null;
  let approveTxRecorded: Hex | null = null;
  let createTxRecorded: Hex | null = null;

  // ── STEP A: mint 5,000 WFAIR to admin (idempotent: skip if already minted) ─
  console.log("");
  console.log("─ STEP A: WFAIR.mint(admin, 5000e18) ─".padEnd(72, "─"));
  let stepASkipped = false;
  if (adminWfairBefore >= SEED_AMOUNT_WFAIR_RAW) {
    console.log(
      `  admin already holds ${fmtWfairRawToHuman(adminWfairBefore)} WFAIR (>= 5000) — skipping mint`,
    );
    stepASkipped = true;
  } else {
    const mintTxHash = await walletClient.writeContract({
      address: WFAIR_ADDRESS,
      abi: erc20Abi,
      functionName: "mint",
      args: [ADMIN_ADDRESS, SEED_AMOUNT_WFAIR_RAW],
    });
    console.log(`  tx: ${mintTxHash}`);
    const mintRcpt = await publicClient.waitForTransactionReceipt({
      hash: mintTxHash,
      // Wait one extra confirmation so subsequent eth_call reads (which may
      // hit a different RPC node behind the load balancer) see the new state.
      confirmations: 2,
    });
    if (mintRcpt.status !== "success") {
      throw new Error(`mint tx failed: ${mintTxHash}`);
    }
    totalGasUsed += mintRcpt.gasUsed;
    totalGasPriceWeightedWei += mintRcpt.gasUsed * mintRcpt.effectiveGasPrice;
    console.log(`  status=success, gasUsed=${mintRcpt.gasUsed}, effGasPrice=${mintRcpt.effectiveGasPrice}`);
    mintTxRecorded = mintTxHash;

    // Read at the receipt's block to avoid stale-replica reads.
    const [wfairTotalSupplyAfterMint, adminWfairAfterMint] = await Promise.all([
      publicClient.readContract({
        address: WFAIR_ADDRESS,
        abi: erc20Abi,
        functionName: "totalSupply",
        blockNumber: mintRcpt.blockNumber,
      }),
      publicClient.readContract({
        address: WFAIR_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ADMIN_ADDRESS],
        blockNumber: mintRcpt.blockNumber,
      }),
    ]);
    const totalSupplyDelta = wfairTotalSupplyAfterMint - wfairTotalSupplyBefore;
    const adminBalanceDelta = adminWfairAfterMint - adminWfairBefore;
    console.log(`  totalSupply delta  = ${totalSupplyDelta} (expected ${SEED_AMOUNT_WFAIR_RAW})`);
    console.log(`  admin balance delta= ${adminBalanceDelta} (expected ${SEED_AMOUNT_WFAIR_RAW})`);
    if (totalSupplyDelta !== SEED_AMOUNT_WFAIR_RAW) {
      throw new Error(
        `totalSupply did not increase by exactly ${SEED_AMOUNT_WFAIR_RAW}, got ${totalSupplyDelta}`,
      );
    }
    if (adminBalanceDelta !== SEED_AMOUNT_WFAIR_RAW) {
      throw new Error(
        `admin balance did not increase by exactly ${SEED_AMOUNT_WFAIR_RAW}`,
      );
    }
  }

  // ── STEP B: approve NPM to pull 5,000 WFAIR ──────────────────────────────
  console.log("");
  console.log("─ STEP B: WFAIR.approve(NPM, 5000e18) ─".padEnd(72, "─"));
  const currentAllowance = await publicClient.readContract({
    address: WFAIR_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [ADMIN_ADDRESS, NPM_ADDRESS],
  });
  console.log(`  current allowance = ${currentAllowance}`);
  if (currentAllowance < SEED_AMOUNT_WFAIR_RAW) {
    const approveTxHash = await walletClient.writeContract({
      address: WFAIR_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [NPM_ADDRESS, SEED_AMOUNT_WFAIR_RAW],
    });
    console.log(`  tx: ${approveTxHash}`);
    const approveRcpt = await publicClient.waitForTransactionReceipt({
      hash: approveTxHash,
      confirmations: 2,
    });
    if (approveRcpt.status !== "success") {
      throw new Error(`approve tx failed: ${approveTxHash}`);
    }
    totalGasUsed += approveRcpt.gasUsed;
    totalGasPriceWeightedWei += approveRcpt.gasUsed * approveRcpt.effectiveGasPrice;
    console.log(`  status=success, gasUsed=${approveRcpt.gasUsed}`);
    approveTxRecorded = approveTxHash;
    const newAllowance = await publicClient.readContract({
      address: WFAIR_ADDRESS,
      abi: erc20Abi,
      functionName: "allowance",
      args: [ADMIN_ADDRESS, NPM_ADDRESS],
      blockNumber: approveRcpt.blockNumber,
    });
    console.log(`  new allowance = ${newAllowance}`);
    if (newAllowance < SEED_AMOUNT_WFAIR_RAW) {
      throw new Error(`allowance still too low: ${newAllowance}`);
    }
  } else {
    console.log("  allowance already sufficient — skipping approve");
  }

  // ── STEP C: createAndInitializePoolIfNecessary ───────────────────────────
  console.log("");
  console.log("─ STEP C: NPM.createAndInitializePoolIfNecessary ─".padEnd(72, "─"));
  let poolAddress: Address;
  if (existingPool !== "0x0000000000000000000000000000000000000000") {
    console.log(`  pool already exists at ${existingPool} — skipping create`);
    poolAddress = existingPool as Address;
  } else {
    const createTxHash = await walletClient.writeContract({
      address: NPM_ADDRESS,
      abi: npmAbi,
      functionName: "createAndInitializePoolIfNecessary",
      args: [token0, token1, FEE_TIER, sqrtPriceX96Init],
    });
    console.log(`  tx: ${createTxHash}`);
    const createRcpt = await publicClient.waitForTransactionReceipt({
      hash: createTxHash,
      confirmations: 2,
    });
    if (createRcpt.status !== "success") {
      throw new Error(`create tx failed: ${createTxHash}`);
    }
    totalGasUsed += createRcpt.gasUsed;
    totalGasPriceWeightedWei += createRcpt.gasUsed * createRcpt.effectiveGasPrice;
    console.log(`  status=success, gasUsed=${createRcpt.gasUsed}`);
    createTxRecorded = createTxHash;
    const fetchedPool = await publicClient.readContract({
      address: FACTORY_ADDRESS,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token0, token1, FEE_TIER],
      blockNumber: createRcpt.blockNumber,
    });
    if (fetchedPool === "0x0000000000000000000000000000000000000000") {
      throw new Error("factory.getPool still returns zero after create");
    }
    poolAddress = fetchedPool as Address;
  }
  console.log(`  pool address = ${poolAddress}`);

  // Pin all pool reads to the current latest block to dodge stale-replica issues.
  const poolReadBlock = await publicClient.getBlockNumber();
  const [slot0, poolToken0, poolToken1, poolFee, poolTickSpacing, poolLiquidity] =
    await Promise.all([
      publicClient.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "slot0",
        blockNumber: poolReadBlock,
      }),
      publicClient.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "token0",
        blockNumber: poolReadBlock,
      }),
      publicClient.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "token1",
        blockNumber: poolReadBlock,
      }),
      publicClient.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "fee",
        blockNumber: poolReadBlock,
      }),
      publicClient.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "tickSpacing",
        blockNumber: poolReadBlock,
      }),
      publicClient.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "liquidity",
        blockNumber: poolReadBlock,
      }),
    ]);
  const slot0SqrtPriceX96 = slot0[0];
  const slot0Tick = slot0[1];
  console.log(`  pool token0 = ${poolToken0} (expected ${token0})`);
  console.log(`  pool token1 = ${poolToken1} (expected ${token1})`);
  console.log(`  pool fee = ${poolFee} (expected ${FEE_TIER})`);
  console.log(`  pool tickSpacing = ${poolTickSpacing} (expected ${TICK_SPACING})`);
  console.log(`  pool slot0.sqrtPriceX96 = ${slot0SqrtPriceX96}`);
  console.log(`  pool slot0.tick = ${slot0Tick}`);
  console.log(`  pool liquidity (pre-mint) = ${poolLiquidity}`);

  if (poolToken0.toLowerCase() !== token0.toLowerCase()) {
    throw new Error("pool token0 mismatch");
  }
  if (poolToken1.toLowerCase() !== token1.toLowerCase()) {
    throw new Error("pool token1 mismatch");
  }
  if (Number(poolFee) !== FEE_TIER) {
    throw new Error(`pool fee mismatch: ${poolFee}`);
  }
  if (Number(poolTickSpacing) !== TICK_SPACING) {
    throw new Error(`pool tickSpacing mismatch: ${poolTickSpacing}`);
  }
  // Sanity: slot0.tick must be >= tickUpper for single-sided WFAIR (token1)
  // mint. This means the pool's internal price (token1/token0 raw) is above
  // the position's range — equivalently, USD price is below the range, which
  // is the case at our $0.49 init for a $0.50→$2.00 range.
  if (slot0Tick < tickUpper) {
    throw new Error(
      `pool current tick (${slot0Tick}) is not >= tickUpper (${tickUpper}); ` +
        `mint would require token0 (USDC) liquidity. Aborting.`,
    );
  }

  // ── STEP D: mint position ────────────────────────────────────────────────
  console.log("");
  console.log("─ STEP D: NPM.mint ─".padEnd(72, "─"));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  // For token1-only single-sided liquidity, NPM only pulls token1; amount0
  // delivered will be 0. amount1Min set to 99% of desired (1% slippage).
  const amount1Desired = SEED_AMOUNT_WFAIR_RAW;
  const amount1Min = (amount1Desired * 99n) / 100n;

  const mintParams = {
    token0,
    token1,
    fee: FEE_TIER,
    tickLower,
    tickUpper,
    amount0Desired: 0n,
    amount1Desired,
    amount0Min: 0n,
    amount1Min,
    recipient: ADMIN_ADDRESS,
    deadline,
  } as const;
  console.log(`  mint params:`);
  console.log(`    tickLower=${mintParams.tickLower}, tickUpper=${mintParams.tickUpper}`);
  console.log(`    amount0Desired=${mintParams.amount0Desired}`);
  console.log(`    amount1Desired=${mintParams.amount1Desired}`);
  console.log(`    amount0Min=${mintParams.amount0Min}`);
  console.log(`    amount1Min=${mintParams.amount1Min}`);
  console.log(`    deadline=${mintParams.deadline}`);

  // simulate first to surface any revert before broadcast
  const sim = await publicClient.simulateContract({
    account,
    address: NPM_ADDRESS,
    abi: npmAbi,
    functionName: "mint",
    args: [mintParams],
  });
  console.log(`  simulate ok — predicted tokenId=${sim.result[0]}, liquidity=${sim.result[1]}, amount0=${sim.result[2]}, amount1=${sim.result[3]}`);

  const mintPosTxHash = await walletClient.writeContract({
    address: NPM_ADDRESS,
    abi: npmAbi,
    functionName: "mint",
    args: [mintParams],
  });
  console.log(`  tx: ${mintPosTxHash}`);
  const mintPosRcpt = await publicClient.waitForTransactionReceipt({
    hash: mintPosTxHash,
    confirmations: 2,
  });
  if (mintPosRcpt.status !== "success") {
    throw new Error(`position mint tx failed: ${mintPosTxHash}`);
  }
  totalGasUsed += mintPosRcpt.gasUsed;
  totalGasPriceWeightedWei += mintPosRcpt.gasUsed * mintPosRcpt.effectiveGasPrice;
  console.log(`  status=success, gasUsed=${mintPosRcpt.gasUsed}`);

  // ── STEP E: extract position NFT id from logs ────────────────────────────
  const events = parseEventLogs({
    abi: npmAbi,
    logs: mintPosRcpt.logs,
    eventName: "IncreaseLiquidity",
  });
  if (events.length === 0) {
    throw new Error("no IncreaseLiquidity event in mint receipt");
  }
  const ev = events[0];
  if (!ev) throw new Error("unreachable");
  const positionTokenId = ev.args.tokenId;
  const liquidityMinted = ev.args.liquidity;
  const amount0Delivered = ev.args.amount0;
  const amount1Delivered = ev.args.amount1;
  console.log(`  position tokenId = ${positionTokenId}`);
  console.log(`  liquidity        = ${liquidityMinted}`);
  console.log(`  amount0 (USDC)   = ${amount0Delivered} (= ${fmtUsdcRawToHuman(amount0Delivered)} USDC)`);
  console.log(`  amount1 (WFAIR)  = ${amount1Delivered} (= ${fmtWfairRawToHuman(amount1Delivered)} WFAIR)`);

  if (amount0Delivered !== 0n) {
    throw new Error(
      `expected amount0=0 (no USDC) for single-sided position, got ${amount0Delivered}`,
    );
  }
  if (amount1Delivered < amount1Min) {
    throw new Error(`amount1 below min: ${amount1Delivered} < ${amount1Min}`);
  }

  // ── post-state verification ──────────────────────────────────────────────
  console.log("");
  console.log("─ post-state verification ─".padEnd(72, "─"));
  const [poolWfairBalance, poolUsdcBalance, finalTotalSupply, adminWfairFinal] =
    await Promise.all([
      publicClient.readContract({
        address: WFAIR_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [poolAddress],
        blockNumber: mintPosRcpt.blockNumber,
      }),
      publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [poolAddress],
        blockNumber: mintPosRcpt.blockNumber,
      }),
      publicClient.readContract({
        address: WFAIR_ADDRESS,
        abi: erc20Abi,
        functionName: "totalSupply",
        blockNumber: mintPosRcpt.blockNumber,
      }),
      publicClient.readContract({
        address: WFAIR_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ADMIN_ADDRESS],
        blockNumber: mintPosRcpt.blockNumber,
      }),
    ]);
  console.log(`  pool WFAIR balance = ${poolWfairBalance} (= ${fmtWfairRawToHuman(poolWfairBalance)} WFAIR)`);
  console.log(`  pool USDC balance  = ${poolUsdcBalance} (= ${fmtUsdcRawToHuman(poolUsdcBalance)} USDC)`);
  console.log(`  WFAIR.totalSupply  = ${finalTotalSupply} (delta from start = ${finalTotalSupply - wfairTotalSupplyBefore})`);
  console.log(`  admin WFAIR (final) = ${adminWfairFinal}`);

  if (poolUsdcBalance !== 0n) {
    console.warn(`  WARNING: pool USDC balance is non-zero: ${poolUsdcBalance}`);
  }
  const expectedSupplyDelta = stepASkipped ? 0n : SEED_AMOUNT_WFAIR_RAW;
  const actualSupplyDelta = finalTotalSupply - wfairTotalSupplyBefore;
  if (actualSupplyDelta !== expectedSupplyDelta) {
    throw new Error(
      `WFAIR totalSupply delta ${actualSupplyDelta}, expected ${expectedSupplyDelta} (stepASkipped=${stepASkipped})`,
    );
  }
  // Sanity: total supply should be exactly 5000e18 regardless (we have only
  // ever minted to admin, no other holders should exist).
  if (finalTotalSupply !== SEED_AMOUNT_WFAIR_RAW) {
    throw new Error(
      `WFAIR.totalSupply (${finalTotalSupply}) is not exactly ${SEED_AMOUNT_WFAIR_RAW}; aborting in case of double-mint`,
    );
  }

  // Average gas price weighted by gas used
  const avgGasPriceWei = totalGasUsed === 0n ? 0n : totalGasPriceWeightedWei / totalGasUsed;
  const totalGasCostWei = totalGasPriceWeightedWei;
  const totalGasCostEth = Number(totalGasCostWei) / 1e18;

  console.log("");
  console.log("=".repeat(72));
  console.log("FINAL REPORT");
  console.log("=".repeat(72));
  console.log(`pool address           : ${poolAddress}`);
  console.log(`position tokenId       : ${positionTokenId}`);
  console.log(`fee tier               : ${FEE_TIER} (= 0.3%)`);
  console.log(`tickLower              : ${tickLower}`);
  console.log(`tickUpper              : ${tickUpper}`);
  console.log(`init price (target)    : $0.49 (slightly below range)`);
  console.log(`range                  : $0.50 → $2.00`);
  console.log(`seeded WFAIR (raw)     : ${amount1Delivered}`);
  console.log(`seeded WFAIR (human)   : ${fmtWfairRawToHuman(amount1Delivered)}`);
  console.log(`seeded USDC            : 0 (founder-funded, single-sided)`);
  console.log(`liquidity (L)          : ${liquidityMinted}`);
  console.log("");
  console.log(`gas used (total)       : ${totalGasUsed}`);
  console.log(`avg gas price (wei)    : ${avgGasPriceWei}`);
  console.log(`gas cost (ETH)         : ${totalGasCostEth.toFixed(8)}`);
  console.log("");
  console.log(`uniswap UI position    : https://app.uniswap.org/positions/v3/base/${positionTokenId}`);
  console.log(`uniswap swap UI        : https://app.uniswap.org/swap?outputCurrency=${WFAIR_ADDRESS}&chain=base`);
  console.log(`pool on basescan       : https://basescan.org/address/${poolAddress}`);
  console.log(`position NFT on basescan: https://basescan.org/token/${NPM_ADDRESS}?a=${positionTokenId}`);
  if (mintTxRecorded) {
    console.log(`WFAIR mint tx          : https://basescan.org/tx/${mintTxRecorded}`);
  } else {
    console.log(`WFAIR mint tx          : (skipped — admin already held 5000 WFAIR)`);
  }
  if (approveTxRecorded) {
    console.log(`approve tx             : https://basescan.org/tx/${approveTxRecorded}`);
  }
  if (createTxRecorded) {
    console.log(`create pool tx         : https://basescan.org/tx/${createTxRecorded}`);
  }
  console.log(`position mint tx       : https://basescan.org/tx/${mintPosTxHash}`);
  console.log("=".repeat(72));

  // Emit machine-readable summary on the last line for downstream jq.
  const summary = {
    pool_address: poolAddress,
    position_token_id: positionTokenId.toString(),
    fee_tier: FEE_TIER,
    tick_lower: tickLower,
    tick_upper: tickUpper,
    init_sqrt_price_x96: sqrtPriceX96Init.toString(),
    seeded_wfair_raw: amount1Delivered.toString(),
    seeded_usdc_raw: amount0Delivered.toString(),
    liquidity: liquidityMinted.toString(),
    wfair_mint_tx: mintTxRecorded,
    approve_tx: approveTxRecorded,
    create_pool_tx: createTxRecorded,
    position_mint_tx: mintPosTxHash,
    total_gas_used: totalGasUsed.toString(),
    avg_gas_price_wei: avgGasPriceWei.toString(),
    gas_cost_eth: totalGasCostEth.toFixed(8),
  };
  console.log("__SUMMARY_JSON__" + JSON.stringify(summary));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
