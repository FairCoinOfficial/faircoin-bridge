# FairCoin ↔ Base Bridge — Deployment & Operations

> Snapshot of the **deployed** state of the WFAIR bridge as of 2026-07-16.
> All addresses below are **public on-chain** data. Operator secrets (wallet
> keys, mnemonics) are **never** stored in this repo — see [Secrets](#secrets).

> **2026-07-16 recovery + migration.** The original DigitalOcean host was lost
> (DO account closed) and its admin/minter EOA key had leaked, so the whole
> bridge was rebuilt on Clouding and **all WFAIR control (admin/minter/pauser +
> the pool LP NFT) was rotated on-chain from the old EOA `0xee8b…7521` to a fresh
> never-exposed EOA `0x094cd46432E9fdcBd31e94b9eB30a16e6F822414`** (old roles
> revoked). The WFAIR contract, pool, and token are unchanged — only the
> controlling key and the host moved.

## What this is

A custodial, centralized bridge between **FairCoin** (Bitcoin-fork L1) and
**Base** (Ethereum L2). It issues **WFAIR**, a 1:1 ERC-20 wrapped representation
of FAIR on Base:

- Deposit FAIR to a bridge-controlled FairCoin address → the bridge **mints**
  the same amount of WFAIR (minus fee) to your Base address.
- **Burn** WFAIR on Base → the bridge **releases** FAIR from its hot wallet to
  your FAIR address.

Launch mode is **solo-EOA** (`MINT_AUTH_MODE=direct_eoa`): a single externally
owned account holds admin/minter/pauser and mints WFAIR directly. No Safe
multisig is wired in production yet. The primary safety backstop is the hard
**TVL cap** (`MAX_TVL_FAIR=1000`).

## Deployed addresses (Base mainnet, chain id 8453)

| What | Address |
|------|---------|
| **WFAIR** ERC-20 token | `0xF2853CedDF47A05Fee0B4b24DFf2925d59737fb3` |
| **Admin / minter EOA** (admin + minter + pauser + pool NFT owner, solo-EOA) | `0x094cd46432E9fdcBd31e94b9eB30a16e6F822414` (rotated 2026-07-16; old `0xee8b…7521` fully revoked) |
| **WFAIR/USDC Uniswap V3 pool** (0.3% fee) | `0x9F4F694390c60b51e30461c785C1345A1545b7ca` |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Uniswap V3 Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| Uniswap V3 NonfungiblePositionManager | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` |

WFAIR: 18 decimals, deployed 2026-04-16, transfers **enabled** (not paused).

## Where the tokens are (current state)

- **WFAIR total supply: 5,000.** Essentially **all 5,000 WFAIR sit inside the
  Uniswap pool** (`0x9F4F69…`) as a **single-sided liquidity position** owned by
  the admin EOA (a Uniswap V3 LP NFT). The admin EOA's own WFAIR balance is ~0
  (dust). The 5,000 WFAIR are **not lost** — they are listed for sale in the pool.
- **Pool is un-traded so far:** 0 USDC and 0 *active* liquidity at the current
  tick, because nobody has bought yet. The spot price is parked at the bottom of
  the seeded range: **~$0.49 per WFAIR**.
- **FAIR custody:** ~**10,000 FAIR** held in the bridge hot wallet on FairCoin
  L1, backing the 5,000 WFAIR at **200%** collateralization. Live reserves:
  `https://bridge.fairco.in/api/bridge/reserves`.

### The Uniswap pool (how the price works)

Seeded by `services/bridge/scripts/seed-pool.ts`: mint 5,000 WFAIR to the admin,
then create + seed a Uniswap V3 **WFAIR/USDC 0.3%** pool with **single-sided
WFAIR** liquidity over the price range **$0.50 → $2.00** (founder-funded — no
USDC put up). As buyers swap USDC in, the price climbs through the range and the
buyers' USDC accumulates in the position (withdrawable by the admin).

- token0 = USDC (6 dec), token1 = WFAIR (18 dec).
- Spot price (USD per WFAIR) from `slot0()`:
  `usdPerWfair = 1e12 / (sqrtPriceX96 / 2**96) ** 2`.
- GeckoTerminal / Dexscreener report **no price** for this token — they ignore
  pools with no trades/active liquidity. The real price exists on-chain; the
  Explorer reads the pool `slot0` directly (see [Explorer integration](#explorer-integration)).

## How it runs

- **Service:** `services/bridge` — Bun/Express public API + BullMQ workers
  (deposit watcher, mint proposer, burn watcher, withdrawal signer, buy watcher,
  buyback worker, masternode-reward booster) + MongoDB (state) + Redis (queues).
  Uses `viem` for Base, `@safe-global/*` for optional Safe flows, `pino` logs.
- **Contracts:** `contracts/` — Foundry project for the WFAIR ERC-20 + TVL cap +
  deploy scripts (`contracts/script/Deploy.s.sol`).
- **Host:** Clouding VPS `fcbridge` (`187.33.151.78`, Ubuntu 26.04, 1 GB RAM +
  2 GB swap). Everything runs under systemd with `Restart=always` and survives
  reboots:
  - Docker `mongo:7` + `redis:7` (bound to 127.0.0.1, memory-capped).
  - `faircoind.service` — local mainnet node (`txindex`+`addressindex`) for
    deposit watching and the hot wallet (`FAIR_HOT_WALLET_MODE=node_wallet`).
  - `faircoin-bridge.service` — `bun src/index.ts` in
    `/opt/faircoin-bridge/services/bridge`, API on 127.0.0.1:3100.
  - `nginx` (self-signed origin cert) → proxies to :3100; **`bridge.fairco.in`**
    = Cloudflare A → 187.33.151.78 (proxied, SSL Full).
- **Config:** `services/bridge/.env` (mode 600 on the host; template
  `.env.example`). `BASE_RPC_URL` = Alchemy Base mainnet.
- **Start (service):** `cd services/bridge && bun install && bun run start`
  (see `package.json`). Requires Mongo + Redis reachable and the `.env` filled in.
- **Base RPC note:** on Alchemy's free tier `eth_getLogs` is capped at a 10-block
  range, so the base (burn) watcher scans in ≤10-block chunks — see
  `services/bridge/src/workers/base-watcher.ts` (`MAX_LOG_RANGE`).

### Key config (`services/bridge/.env.example`)

- `MINT_AUTH_MODE=direct_eoa` — EOA mints directly (needs MINTER_ROLE on WFAIR).
- `MAX_TVL_FAIR=1000`, `MIN_DEPOSIT_FAIR=10`, `BRIDGE_FEE_BPS=30` (0.3%),
  `PER_ADDRESS_DAILY_CAP_FAIR=100`, `FAIR_CONFIRMATIONS=6`, `BASE_CONFIRMATIONS=20`.
- Buy flow (buy.fairco.in): `USDC_BASE_ADDRESS`, `WFAIR_USDC_POOL_ADDRESS`,
  `UNISWAP_V3_QUOTER`, `UNISWAP_V3_SWAP_ROUTER`, plus a `BUY_PAYMENT_HD_*` wallet.
- **Disabled by default:** `BUYBACK_ENABLED=false` (periodic USDC→WFAIR buyback,
  split 50% burn / 30% treasury / 20% masternode pool) and
  `MASTERNODE_REWARDS_ENABLED=false` (distributes the 20% slice pro-rata to
  enabled masternodes). Enable only after wiring the three FAIR destinations.

## Explorer integration

The FairCoin Explorer (`~/FairCoinWorkspace/Explorer`, prod `explorer.fairco.in`)
surfaces this bridge:

- **Home "FAIR Price" card** reads the pool spot price on-chain (`slot0` of
  `0x9F4F69…`) → shows ~$0.49. (Falls back to GeckoTerminal/Dexscreener.)
- **Home "WFAIR Bridge" card** + the **`/bridge`** page read reserves via the
  same-origin proxy `GET /api/bridge/reserves` (the bridge host sends no CORS
  header, so the Explorer server proxies it).

## Secrets

Operator keys/wallets are kept **outside this repo** (NOT committed). On the
`fcbridge` host they live in `/opt/faircoin-bridge/secrets/` (mode 600):
`eoa.key` (the `0x094c…` Base admin/minter key) and `fair-deposit-hd.txt` (the
watch-only deposit HD — only the xpub goes in `.env`). The FairCoin hot wallet is
the local `faircoind` wallet. Off-host backup lives on the operator's encrypted
USB (`FairCoin-Backup-.../bridge/`). The on-chain chain keys (alert / genesis /
spork) are separate from the bridge. Never commit any of these or paste them into
issues/docs — the previous admin EOA key leaked exactly that way and had to be
rotated out.

## Caveats

- Experimental, AML/audit pending (see the risk disclosure in `README.md`).
- Single-EOA admin = single point of trust/failure until a Safe multisig is wired.
- The pool is single-sided and un-traded; the displayed price is a thin floor
  price, not a deep market.
