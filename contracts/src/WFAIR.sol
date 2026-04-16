// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title WFAIR - Wrapped FairCoin on Base
/// @notice 1:1 wrapped FairCoin ERC-20 issued by a custodial bridge.
/// @dev Mint authority is intended to be a 2-of-3 Gnosis Safe on Base.
///      Deployer holds no privileges; all roles are granted to the `admin`
///      address (the Safe) in the constructor.
contract WFAIR is ERC20, ERC20Burnable, ERC20Permit, AccessControl, Pausable {
    /// @notice Role that authorizes minting of new WFAIR tokens.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role that authorizes pausing and unpausing of all token
    ///         movement (mint, burn, transfer).
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Emitted when the bridge mints WFAIR without deposit metadata.
    /// @param to Recipient of the newly minted tokens.
    /// @param amount Amount minted, in wei (18 decimals).
    event Minted(address indexed to, uint256 amount);

    /// @notice Emitted when the bridge mints WFAIR in response to a specific
    ///         FairCoin deposit. Enables on-chain traceability from L2 mint
    ///         back to the originating L1 UTXO (txid, vout).
    /// @param faircoinTxid Hash of the FairCoin transaction containing the deposit.
    /// @param vout Output index within the FairCoin transaction.
    /// @param to Recipient of the newly minted tokens.
    /// @param amount Amount minted, in wei (18 decimals).
    event MintedForDeposit(bytes32 indexed faircoinTxid, uint32 vout, address indexed to, uint256 amount);

    /// @notice Emitted when a holder burns WFAIR to withdraw FairCoin.
    /// @param from Account that burned the tokens.
    /// @param amount Amount burned, in wei (18 decimals).
    /// @param faircoinAddress Raw FairCoin destination address bytes (base58).
    event BridgeBurn(address indexed from, uint256 amount, bytes faircoinAddress);

    /// @notice Deploys the WFAIR token and assigns every role to `admin`.
    /// @dev The deployer (`msg.sender`) is intentionally not granted any
    ///      privileges. `admin` is expected to be the bridge Safe.
    /// @param admin Address that receives DEFAULT_ADMIN_ROLE, MINTER_ROLE,
    ///              and PAUSER_ROLE.
    constructor(address admin) ERC20("Wrapped FairCoin", "WFAIR") ERC20Permit("Wrapped FairCoin") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /// @notice Mints WFAIR to `to`. Restricted to MINTER_ROLE.
    /// @param to Recipient of the newly minted tokens.
    /// @param amount Amount to mint, in wei (18 decimals).
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) whenNotPaused {
        _mint(to, amount);
        emit Minted(to, amount);
    }

    /// @notice Mints WFAIR to `to` in response to a FairCoin deposit.
    /// @dev Emits `MintedForDeposit` with full deposit metadata so indexers
    ///      can reconcile L1 deposits with L2 mints. Restricted to MINTER_ROLE.
    /// @param to Recipient of the newly minted tokens.
    /// @param amount Amount to mint, in wei (18 decimals).
    /// @param faircoinTxid FairCoin transaction hash of the deposit.
    /// @param vout Output index within the FairCoin transaction.
    function mintForDeposit(address to, uint256 amount, bytes32 faircoinTxid, uint32 vout)
        external
        onlyRole(MINTER_ROLE)
        whenNotPaused
    {
        _mint(to, amount);
        emit MintedForDeposit(faircoinTxid, vout, to, amount);
    }

    /// @notice Burns `amount` WFAIR from the caller and signals the bridge to
    ///         release the equivalent FairCoin to `faircoinAddress`.
    /// @dev The bridge service listens for `BridgeBurn` events and performs
    ///      the L1 release off-chain. `faircoinAddress` is treated as raw
    ///      bytes; length bounds (26-35) follow standard base58 FairCoin
    ///      address encoding and provide a cheap sanity check. Final address
    ///      validation (checksum, prefix) is performed off-chain by the
    ///      bridge service.
    /// @param amount Amount to burn, in wei (18 decimals). Must be positive.
    /// @param faircoinAddress Raw FairCoin destination address (base58 bytes).
    function bridgeBurn(uint256 amount, bytes calldata faircoinAddress) external whenNotPaused {
        require(amount > 0, "WFAIR: amount must be positive");
        require(faircoinAddress.length >= 26 && faircoinAddress.length <= 35, "WFAIR: invalid faircoin address length");

        _burn(msg.sender, amount);
        emit BridgeBurn(msg.sender, amount, faircoinAddress);
    }

    /// @notice Pauses all token movement (mint, burn, transfer).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpauses token movement.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @dev OpenZeppelin v5 routes every mint, burn, and transfer through
    ///      `_update`. Applying `whenNotPaused` here is the single point at
    ///      which the pause switch gates all balance changes.
    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        super._update(from, to, value);
    }
}
