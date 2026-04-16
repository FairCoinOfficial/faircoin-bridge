# faircoin-bridge

Centralized custodial bridge between FairCoin (Bitcoin-fork L1) and Base (Ethereum L2). Issues **WFAIR**, a 1:1 ERC-20 wrapped representation of FAIR on Base.

## Risk disclosure

**Experimental software. AI-assisted codebase. No external audit.**

WFAIR is launching on Base mainnet without a formal third-party security audit. The primary safety mitigation is a hard **TVL cap** enforced at the smart contract and service layer, combined with a conservative hot-wallet ratio and per-address daily caps. Users deposit at their own risk. Do not bridge funds you are not prepared to lose. A full security model and threat analysis will be published as `SECURITY.md` prior to public launch.

If you find a security issue, please email `security@fairco.in` before disclosing publicly.

## What is WFAIR

WFAIR is a 1:1 wrapped representation of FairCoin (FAIR) on Base. A user deposits FAIR to a bridge-controlled FairCoin address; after confirmation, the bridge mints an equivalent amount of WFAIR (minus a small bridge fee) to the user's Base address. Burning WFAIR on Base triggers a FAIR withdrawal from the bridge's FairCoin hot wallet to the user's FAIR address.

The bridge is **custodial** and **centralized**: FAIR reserves are held by the bridge operator, and WFAIR minting is controlled by a Safe multisig on Base. This is not a trust-minimized bridge — it trades trustlessness for simplicity, speed of shipping, and a clean user experience.

## Architecture

- **FairCoin side**: watch-only HD xpub per-user deposit addresses (BIP44 path `m/44'/119'/0'/0`), `faircoin-cli`/RPC to detect confirmed deposits, a hot wallet (capped at 5% of TVL) to fund withdrawals, with the remainder in cold storage.
- **Base side**: `WFAIR` ERC-20 contract with a Safe multisig owner. The bridge service proposes mint/burn-release transactions to Safe Transaction Service; signers co-sign; Safe executes.
- **Bridge service** (`services/bridge`): a Bun/Node process running Express (public API), BullMQ workers (deposit watcher, mint proposer, burn watcher, withdrawal signer), MongoDB for state, Redis for queues. Uses `viem` for Base RPC, `@safe-global/protocol-kit` + `api-kit` for Safe interactions, `pino` for logging.
- **Contracts** (`contracts/`): Foundry project for the `WFAIR` ERC-20, TVL-cap enforcement, and deployment scripts. Initialized in a later step.

## Repo layout

```
faircoin-bridge/
  contracts/                 Foundry project (WFAIR ERC-20, TVL cap, deploy scripts)
  services/
    bridge/                  Bridge service (Express API + BullMQ workers)
      src/
        rpc/                 FairCoin + Base RPC clients
        hd/                  HD wallet derivation (xpub watch-only, xprv hot wallet)
        workers/             BullMQ workers (deposits, mints, burns, withdrawals)
        signer/              Safe proposer/co-signer + FairCoin signer
        api/                 Public API (health, deposit address, status)
        models/              Mongoose models
        lib/                 Shared utilities (logger, config, errors)
  tsconfig.base.json         Shared TypeScript config
  package.json               Root workspace (bun workspaces)
```

## Development setup

Prerequisites:
- [Bun](https://bun.sh) >= 1.2
- Node.js 20+ (for tooling compatibility)
- MongoDB (local or Atlas)
- Redis 7+
- [Foundry](https://book.getfoundry.sh) (for the `contracts/` package, once initialized)
- A synced `faircoind` node (testnet or mainnet, matching `FAIR_NETWORK`)

Quickstart:

```bash
git clone <repo-url> faircoin-bridge
cd faircoin-bridge
bun install
cp .env.example .env
cp services/bridge/.env.example services/bridge/.env
# fill in FAIR_RPC_*, BASE_RPC_URL, WFAIR_CONTRACT_ADDRESS, SAFE_ADDRESS, etc.
bun run dev
```

Useful scripts (from repo root):

```bash
bun run dev         # start the bridge service in watch mode
bun run test        # run bridge service tests
bun run typecheck   # type-check all workspaces
bun run build       # build all workspaces
```

## Deploy

Mainnet launch follows the Day 8 launch procedure documented separately. High-level sequence:

1. Deploy `WFAIR` and TVL-cap logic via Foundry scripts with the Safe multisig as owner.
2. Verify contracts on BaseScan.
3. Deploy bridge service (containerized, with KMS-backed signer keys and encrypted env).
4. Fund the FairCoin hot wallet (capped at 5% of TVL) from cold storage.
5. Enable deposits with TVL cap set to initial conservative limit; ramp as confidence grows.

## License

MIT. See `LICENSE`.
