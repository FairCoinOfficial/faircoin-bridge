import { getAddress, type Address } from "viem";
import { config } from "../config.js";
import { basePublic } from "./base.js";
import {
  uniswapV3PoolAbi,
  uniswapV3QuoterAbi,
} from "./uniswap-abi.js";

/**
 * Read-only helpers around the Uniswap v3 Quoter and the live WFAIR/USDC pool.
 *
 * The Quoter functions are non-view (they revert with the result encoded in
 * the revert data, which viem decodes for us via `simulateContract`). The
 * pool reads are plain view calls and use `readContract`.
 */

interface PoolMeta {
  token0: Address;
  token1: Address;
  fee: number;
  /** Address of the WFAIR token in this pool (token1 on the seeded pool). */
  wfair: Address;
  /** Address of the USDC token in this pool (token0 on the seeded pool). */
  usdc: Address;
}

let cachedPoolMeta: PoolMeta | null = null;

export async function getPoolMeta(): Promise<PoolMeta> {
  if (cachedPoolMeta) return cachedPoolMeta;
  const poolAddress = config.WFAIR_USDC_POOL_ADDRESS as `0x${string}`;
  const [token0, token1, fee] = await Promise.all([
    basePublic.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: "token0",
    }),
    basePublic.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: "token1",
    }),
    basePublic.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: "fee",
    }),
  ]);
  const usdcAddress = getAddress(config.USDC_BASE_ADDRESS);
  const wfairAddress = getAddress(config.WFAIR_CONTRACT_ADDRESS);
  const t0 = getAddress(token0);
  const t1 = getAddress(token1);
  const usdc = t0 === usdcAddress ? t0 : t1 === usdcAddress ? t1 : null;
  const wfair = t0 === wfairAddress ? t0 : t1 === wfairAddress ? t1 : null;
  if (!usdc || !wfair) {
    throw new Error(
      `pool ${poolAddress} does not match configured WFAIR + USDC addresses (token0=${t0}, token1=${t1})`,
    );
  }
  cachedPoolMeta = { token0: t0, token1: t1, fee: Number(fee), usdc, wfair };
  return cachedPoolMeta;
}

/**
 * Quote how much USDC is needed to receive `wfairOut` from the pool. Returns
 * the input USDC amount in microUSDC (6-decimal). Reverts if liquidity is
 * insufficient — caller must surface a friendly error.
 */
export async function quoteUsdcInForExactWfairOut(
  wfairOut: bigint,
): Promise<bigint> {
  const pool = await getPoolMeta();
  const { result } = await basePublic.simulateContract({
    address: config.UNISWAP_V3_QUOTER as `0x${string}`,
    abi: uniswapV3QuoterAbi,
    functionName: "quoteExactOutputSingle",
    args: [
      {
        tokenIn: pool.usdc,
        tokenOut: pool.wfair,
        amount: wfairOut,
        fee: pool.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  // result tuple: [amountIn, sqrtPriceX96After, initializedTicksCrossed, gasEstimate]
  return result[0];
}

/**
 * Quote how much WFAIR comes out for a given USDC input. Used by the
 * orchestrator at swap time to compute amountOutMinimum from the actual
 * received funds.
 */
export async function quoteWfairOutForExactUsdcIn(
  usdcIn: bigint,
): Promise<bigint> {
  const pool = await getPoolMeta();
  const { result } = await basePublic.simulateContract({
    address: config.UNISWAP_V3_QUOTER as `0x${string}`,
    abi: uniswapV3QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: pool.usdc,
        tokenOut: pool.wfair,
        amountIn: usdcIn,
        fee: pool.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return result[0];
}

/**
 * Reset the cached pool meta. Tests use this; production never invalidates.
 */
export function resetPoolMetaCache(): void {
  cachedPoolMeta = null;
}
