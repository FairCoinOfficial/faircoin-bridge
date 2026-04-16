// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {WFAIR} from "../src/WFAIR.sol";

/// @title WFAIR full test suite
contract WFAIRTest is Test {
    WFAIR internal wfair;

    address internal safe;
    address internal alice;
    address internal bob;
    address internal minter;
    address internal pauser;
    address internal attacker;

    bytes32 internal constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    // Plausible FairCoin base58 address (27 chars -> 27 bytes).
    bytes internal constant VALID_FAIRCOIN_ADDR = bytes("fXyZabcDEF1234567890ABCDEFG");

    // Events mirrored from WFAIR for vm.expectEmit.
    event Minted(address indexed to, uint256 amount);
    event MintedForDeposit(bytes32 indexed faircoinTxid, uint32 vout, address indexed to, uint256 amount);
    event BridgeBurn(address indexed from, uint256 amount, bytes faircoinAddress);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function setUp() public {
        safe = makeAddr("safe");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        minter = makeAddr("minter");
        pauser = makeAddr("pauser");
        attacker = makeAddr("attacker");

        // MINTER_ROLE is granted to `minter` directly in the constructor,
        // matching the bridge's `direct_eoa` mint-authority mode. The Safe
        // still holds MINTER_ROLE and can rotate the minter at any time.
        wfair = new WFAIR(safe, minter);

        vm.prank(safe);
        wfair.grantRole(PAUSER_ROLE, pauser);
    }

    // ---------- metadata ----------

    function test_Decimals() public view {
        assertEq(wfair.decimals(), 18);
    }

    function test_NameSymbol() public view {
        assertEq(wfair.name(), "Wrapped FairCoin");
        assertEq(wfair.symbol(), "WFAIR");
    }

    function test_DeployerHasNoRoles() public view {
        assertFalse(wfair.hasRole(DEFAULT_ADMIN_ROLE, address(this)));
        assertFalse(wfair.hasRole(MINTER_ROLE, address(this)));
        assertFalse(wfair.hasRole(PAUSER_ROLE, address(this)));
    }

    function test_SafeHasAllRoles() public view {
        assertTrue(wfair.hasRole(DEFAULT_ADMIN_ROLE, safe));
        assertTrue(wfair.hasRole(MINTER_ROLE, safe));
        assertTrue(wfair.hasRole(PAUSER_ROLE, safe));
    }

    function test_MinterAddressGrantedInConstructor() public view {
        assertTrue(wfair.hasRole(MINTER_ROLE, minter));
        // Minter EOA must not be promoted to admin or pauser implicitly.
        assertFalse(wfair.hasRole(DEFAULT_ADMIN_ROLE, minter));
        assertFalse(wfair.hasRole(PAUSER_ROLE, minter));
    }

    function test_ConstructorRevertsWhenAdminZero() public {
        vm.expectRevert(bytes("WFAIR: admin is zero"));
        new WFAIR(address(0), minter);
    }

    function test_ConstructorAllowsZeroMinter() public {
        WFAIR solo = new WFAIR(safe, address(0));

        assertTrue(solo.hasRole(DEFAULT_ADMIN_ROLE, safe));
        assertTrue(solo.hasRole(MINTER_ROLE, safe));
        assertTrue(solo.hasRole(PAUSER_ROLE, safe));
        // The zero address is not a role-bearer: Safe is the sole minter.
        assertFalse(solo.hasRole(MINTER_ROLE, address(0)));
    }

    // ---------- minting ----------

    function test_MintByMinter() public {
        uint256 amount = 1_000 ether;

        vm.expectEmit(true, true, false, true, address(wfair));
        emit Transfer(address(0), alice, amount);
        vm.expectEmit(true, false, false, true, address(wfair));
        emit Minted(alice, amount);

        vm.prank(minter);
        wfair.mint(alice, amount);

        assertEq(wfair.balanceOf(alice), amount);
        assertEq(wfair.totalSupply(), amount);
    }

    function test_RevertWhen_MintByNonMinter() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, MINTER_ROLE)
        );
        vm.prank(attacker);
        wfair.mint(alice, 1 ether);
    }

    function test_MintForDepositEmitsEvent() public {
        bytes32 txid = keccak256("faircoin-tx-1");
        uint32 vout = 2;
        uint256 amount = 5 ether;

        vm.expectEmit(true, true, false, true, address(wfair));
        emit Transfer(address(0), alice, amount);
        vm.expectEmit(true, true, false, true, address(wfair));
        emit MintedForDeposit(txid, vout, alice, amount);

        vm.prank(minter);
        wfair.mintForDeposit(alice, amount, txid, vout);

        assertEq(wfair.balanceOf(alice), amount);
    }

    function test_RevertWhen_MintForDepositByNonMinter() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, MINTER_ROLE)
        );
        vm.prank(attacker);
        wfair.mintForDeposit(alice, 1 ether, keccak256("x"), 0);
    }

    // ---------- burning ----------

    function test_BurnSelfOk() public {
        vm.prank(minter);
        wfair.mint(alice, 10 ether);

        vm.prank(alice);
        wfair.burn(3 ether);

        assertEq(wfair.balanceOf(alice), 7 ether);
        assertEq(wfair.totalSupply(), 7 ether);
    }

    function test_BridgeBurnEmitsEvent() public {
        uint256 amount = 4 ether;
        vm.prank(minter);
        wfair.mint(alice, amount);

        vm.expectEmit(true, true, false, true, address(wfair));
        emit Transfer(alice, address(0), amount);
        vm.expectEmit(true, false, false, true, address(wfair));
        emit BridgeBurn(alice, amount, VALID_FAIRCOIN_ADDR);

        vm.prank(alice);
        wfair.bridgeBurn(amount, VALID_FAIRCOIN_ADDR);

        assertEq(wfair.balanceOf(alice), 0);
        assertEq(wfair.totalSupply(), 0);
    }

    function test_RevertWhen_BridgeBurnAddressTooShort() public {
        vm.prank(minter);
        wfair.mint(alice, 1 ether);

        bytes memory tooShort = new bytes(25);
        vm.expectRevert(bytes("WFAIR: invalid faircoin address length"));
        vm.prank(alice);
        wfair.bridgeBurn(1 ether, tooShort);
    }

    function test_RevertWhen_BridgeBurnAddressTooLong() public {
        vm.prank(minter);
        wfair.mint(alice, 1 ether);

        bytes memory tooLong = new bytes(36);
        vm.expectRevert(bytes("WFAIR: invalid faircoin address length"));
        vm.prank(alice);
        wfair.bridgeBurn(1 ether, tooLong);
    }

    function test_RevertWhen_BridgeBurnZeroAmount() public {
        vm.prank(minter);
        wfair.mint(alice, 1 ether);

        vm.expectRevert(bytes("WFAIR: amount must be positive"));
        vm.prank(alice);
        wfair.bridgeBurn(0, VALID_FAIRCOIN_ADDR);
    }

    function test_RevertWhen_BurnMoreThanBalance() public {
        vm.prank(minter);
        wfair.mint(alice, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 1 ether, 2 ether));
        vm.prank(alice);
        wfair.bridgeBurn(2 ether, VALID_FAIRCOIN_ADDR);
    }

    // ---------- pause ----------

    function test_PauseBlocksMint() public {
        vm.prank(pauser);
        wfair.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(minter);
        wfair.mint(alice, 1 ether);
    }

    function test_PauseBlocksTransfer() public {
        vm.prank(minter);
        wfair.mint(alice, 10 ether);

        vm.prank(pauser);
        wfair.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        wfair.transfer(bob, 1 ether);
    }

    function test_PauseBlocksBurn() public {
        vm.prank(minter);
        wfair.mint(alice, 10 ether);

        vm.prank(pauser);
        wfair.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        wfair.bridgeBurn(1 ether, VALID_FAIRCOIN_ADDR);
    }

    function test_UnpauseAllowsTransferAgain() public {
        vm.prank(minter);
        wfair.mint(alice, 10 ether);

        vm.prank(pauser);
        wfair.pause();
        vm.prank(pauser);
        wfair.unpause();

        vm.prank(alice);
        assertTrue(wfair.transfer(bob, 4 ether));

        assertEq(wfair.balanceOf(alice), 6 ether);
        assertEq(wfair.balanceOf(bob), 4 ether);
    }

    function test_RevertWhen_PauseByNonPauser() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, PAUSER_ROLE)
        );
        vm.prank(attacker);
        wfair.pause();
    }

    function test_RevertWhen_UnpauseByNonPauser() public {
        vm.prank(pauser);
        wfair.pause();

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, PAUSER_ROLE)
        );
        vm.prank(attacker);
        wfair.unpause();
    }

    // ---------- roles ----------

    function test_AdminCanGrantAndRevokeRoles() public {
        address newMinter = makeAddr("newMinter");

        vm.prank(safe);
        wfair.grantRole(MINTER_ROLE, newMinter);
        assertTrue(wfair.hasRole(MINTER_ROLE, newMinter));

        vm.prank(newMinter);
        wfair.mint(alice, 1 ether);
        assertEq(wfair.balanceOf(alice), 1 ether);

        vm.prank(safe);
        wfair.revokeRole(MINTER_ROLE, newMinter);
        assertFalse(wfair.hasRole(MINTER_ROLE, newMinter));

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, newMinter, MINTER_ROLE)
        );
        vm.prank(newMinter);
        wfair.mint(alice, 1 ether);
    }

    function test_RevertWhen_GrantRoleByNonAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, DEFAULT_ADMIN_ROLE
            )
        );
        vm.prank(attacker);
        wfair.grantRole(MINTER_ROLE, attacker);
    }

    // ---------- permit ----------

    function test_Permit() public {
        uint256 ownerKey = 0xA11CE;
        address owner = vm.addr(ownerKey);
        uint256 value = 50 ether;
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(minter);
        wfair.mint(owner, value);

        uint256 nonce = wfair.nonces(owner);
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, bob, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", wfair.DOMAIN_SEPARATOR(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        wfair.permit(owner, bob, value, deadline, v, r, s);

        assertEq(wfair.allowance(owner, bob), value);
        assertEq(wfair.nonces(owner), nonce + 1);

        vm.prank(bob);
        assertTrue(wfair.transferFrom(owner, bob, value));

        assertEq(wfair.balanceOf(bob), value);
        assertEq(wfair.balanceOf(owner), 0);
        assertEq(wfair.allowance(owner, bob), 0);
    }

    // ---------- fuzz ----------

    /// @dev Bound totalSupply well under 2^96 so interaction with Votes-style
    ///      extensions (should we add them later) stays safe.
    function testFuzz_Mint(uint96 amount) public {
        vm.prank(minter);
        wfair.mint(alice, amount);

        assertEq(wfair.balanceOf(alice), amount);
        assertEq(wfair.totalSupply(), amount);
    }

    function testFuzz_BridgeBurn(uint96 amount, uint8 addrLen) public {
        amount = uint96(bound(uint256(amount), 1, type(uint96).max));
        addrLen = uint8(bound(uint256(addrLen), 26, 35));

        vm.prank(minter);
        wfair.mint(alice, amount);

        bytes memory addr = new bytes(addrLen);
        for (uint256 i = 0; i < addrLen; i++) {
            addr[i] = bytes1(uint8(0x41 + (i % 26)));
        }

        vm.prank(alice);
        wfair.bridgeBurn(amount, addr);

        assertEq(wfair.balanceOf(alice), 0);
        assertEq(wfair.totalSupply(), 0);
    }
}
