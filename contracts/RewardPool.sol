// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title Agent Cards season reward pool
/// @notice Pays each ladder season's reward pool (80% of the season's revenue) to the players. The owner deposits a
/// season's pool in BNB together with the Merkle root of its payouts, one leaf per wallet bound to this contract and
/// that season, and each wallet claims its own amount with its proof for 90 days. A deposit can't be changed, topped
/// up or taken back: while a season's claim window is open nobody, the owner included, can move its BNB anywhere but
/// to the wallets in its root, and a season's claims can never reach another season's BNB. Once the window has closed,
/// anyone can sweep what is left to the treasury, which is fixed at deploy. Ownership moves in two steps with a
/// 48-hour wait, like every setting that moves money in AgentCards.
contract RewardPool is Ownable2Step, ReentrancyGuardTransient {
    uint256 public constant CLAIM_WINDOW = 90 days;
    uint256 public constant TIMELOCK = 48 hours;

    struct Season {
        bytes32 root; // Merkle root of leaf(season, wallet, amount) leaves; 0 = not funded
        uint128 funded; // wei deposited
        uint128 claimed; // wei paid out so far
        uint64 claimEnds; // the last second a claim is accepted
        bool swept;
    }

    address payable public immutable treasury; // where a closed season's unclaimed BNB goes
    mapping(uint256 => Season) public seasons;
    mapping(uint256 => mapping(address => bool)) public claimed; // season -> wallet -> paid
    uint64 public ownerEta; // when a started ownership transfer may be accepted; 0 = none started

    event Funded(uint256 indexed season, bytes32 root, uint256 amount, uint64 claimEnds);
    event Claimed(uint256 indexed season, address indexed wallet, uint256 amount);
    event Swept(uint256 indexed season, address indexed treasury, uint256 amount);
    event OwnershipProposed(address indexed newOwner, uint64 eta);

    error AlreadyFunded();
    error BadFunding();
    error NotFunded();
    error ClaimClosed();
    error AlreadyClaimed();
    error BadProof();
    error PoolShort();
    error StillOpen();
    error AlreadySwept();
    error PaymentFailed();
    error RenounceDisabled();
    error ZeroAddress();
    error NotReady();

    constructor(address owner_, address payable treasury_) Ownable(owner_) {
        // owner is passed in because the contract is deployed through a CREATE2 factory
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
    }

    /// Deposits a season's pool (msg.value) and fixes its payouts (root). Once per season, and final: the claim
    /// window runs CLAIM_WINDOW from now.
    function fund(uint256 season, bytes32 root) external payable onlyOwner {
        if (seasons[season].root != bytes32(0)) revert AlreadyFunded();
        if (root == bytes32(0) || msg.value == 0 || msg.value > type(uint128).max) revert BadFunding();
        uint64 ends = uint64(block.timestamp + CLAIM_WINDOW);
        seasons[season] = Season(root, uint128(msg.value), 0, ends, false);
        emit Funded(season, root, msg.value, ends);
    }

    /// Pays the caller its amount in a funded season, once, while the season's claim window is open.
    function claim(uint256 season, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Season storage s = seasons[season];
        if (s.root == bytes32(0)) revert NotFunded();
        if (block.timestamp > s.claimEnds) revert ClaimClosed();
        if (claimed[season][msg.sender]) revert AlreadyClaimed();
        if (!MerkleProof.verifyCalldata(proof, s.root, leaf(season, msg.sender, amount))) revert BadProof();
        if (amount > s.funded - s.claimed) revert PoolShort(); // the season holds less than its root promised
        claimed[season][msg.sender] = true;
        s.claimed += uint128(amount);
        emit Claimed(season, msg.sender, amount);
        _send(payable(msg.sender), amount);
    }

    /// Sends what a season left unclaimed to the treasury, only after its claim window has closed. Anyone may call
    /// it: the destination is fixed, so a lost owner key can't strand the BNB.
    function sweep(uint256 season) external nonReentrant {
        Season storage s = seasons[season];
        if (s.root == bytes32(0)) revert NotFunded();
        if (block.timestamp <= s.claimEnds) revert StillOpen();
        if (s.swept) revert AlreadySwept();
        s.swept = true;
        uint256 left = s.funded - s.claimed;
        emit Swept(season, treasury, left);
        _send(treasury, left);
    }

    /// A payout's leaf, bound to this contract and the season, so a list funded under another season or pool pays
    /// nobody twice; hashed twice, so no pair of inner nodes can pass for a leaf.
    function leaf(uint256 season, address wallet, uint256 amount) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(address(this), season, wallet, amount))));
    }

    /// Ownership only moves with transferOwnership + acceptOwnership; giving it up would strand unclaimed BNB.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// Starts the 48-hour wait before `newOwner` may accept (address(0) cancels): one tricked signature can't hand
    /// the contract over at once, and the owner sees OwnershipTransferStarted in time to cancel.
    function transferOwnership(address newOwner) public override onlyOwner {
        super.transferOwnership(newOwner);
        ownerEta = newOwner == address(0) ? 0 : uint64(block.timestamp + TIMELOCK);
        emit OwnershipProposed(newOwner, ownerEta);
    }

    function acceptOwnership() public override {
        if (ownerEta == 0 || block.timestamp < ownerEta) revert NotReady();
        ownerEta = 0;
        super.acceptOwnership(); // only the pending owner
    }

    function _send(address payable to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PaymentFailed();
    }
}
