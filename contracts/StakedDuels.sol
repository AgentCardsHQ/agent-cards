// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title Staked duels for Agent Cards
/// @notice Two cards' holders stake the same amount; the winner gets both stakes minus a 7.5% cut from each side
/// (7.5% of the pot), which goes to the treasury; a draw gives each side its full stake back, with no cut. A holder
/// never sends BNB to anyone directly: they deposit into their own balance here once, every duel moves money only
/// inside this contract, and they withdraw what's free whenever they like.
///
/// Matching (the open table, direct challenges, level range) happens off-chain: a player signs an Intent — their
/// card, a stake amount from the allowed list, optionally one named opponent for a direct challenge — for free,
/// no gas, no on-chain trace until it is used (or cancelled with cancelIntent). formDuel takes two compatible,
/// unexpired, unused Intents plus our server's signature over that exact pairing (Match): anyone may send the
/// transaction, but only a pairing the server chose can lock money. Without that, anyone who sees an open-table
/// Intent (in the mempool, in a leaked queue) could pair it with their own strongest card and skip the level
/// range. Both stakes move from balance into the duel in one transaction, so a duel that never finds a match
/// never touches anyone's money and needs no refund. A direct challenge's named opponent is enforced on-chain too.
///
/// The result must be unknowable to anyone before both stakes are locked. formDuel fixes a future block
/// (lockBlock, the next block) and settle() seeds the outcome from SEED_BLOCKS consecutive block hashes starting
/// there — nobody but the validator producing them can see any of them before they are mined. On BSC one
/// validator produces 8 blocks in a row, so the three hashes usually come from one producer, who could grind them;
/// fine for small stakes, a VRF is the answer if stakes grow. The actual battle is simulated off-chain from that
/// seed plus the inputs the server committed to in formDuel (`terms`: a hash of both cards' stats and the rules
/// version, emitted before the seed exists), so anyone can re-run a duel afterwards and catch a wrong winner.
/// This contract only checks that a settlement is signed by our server AND names the seed it read from the chain.
/// A draw is a settlement too: the same signature over the same typed data with winner == address(0), so it is bound
/// to this contract's seed exactly as a win is.
/// The server shows the duel round by round and sends settle() only once the last round is out (a settle names the
/// winner, or the draw, on chain the moment it is sent), about a minute and a half after the lock. So settle() takes the seed
/// for SETTLE_WINDOW blocks after lockBlock (~52 minutes at BSC's 0.45 s blocks): blockhash() for the last 256
/// blocks, older ones from the chain's own EIP-2935 history contract (HISTORY, which keeps the last 8,191 block
/// hashes on BSC mainnet and testnet), and only while that history's record of the previous block matches
/// blockhash(), so a history that stopped being written can never stand in a hash known in advance.
/// The signer can still name either side the winner, call a draw, or never settle a result it dislikes (the duel is
/// then refunded) — the trust the game server already holds over the free ladder and CardEvolution's vouchers. Pause
/// stops new money and new settlements at once and the signer rotates behind a 48-hour wait. maxOpenDuels and
/// maxLockedValue cap what is at stake at one moment, NOT in total: a duel settles when its reveal ends, about a
/// minute and a half after it locks, and frees its room, so a leaked signer can keep cycling through every signed,
/// unexpired Intent it can get until the owner pauses; maxSettlePerHour caps the value settle() can move in an
/// hour, so that is a small amount (a draw isn't counted: each side only gets its own stake back, so no money leaves
/// anyone). If settle() never comes — outage, bug, a pause that outlasts the window, a
/// missed settle window — either side's stake is theirs again with no server involved, as soon as the window is
/// gone (block lockBlock + SETTLE_WINDOW + 1) or 24 hours after the duel locked, whichever is first.
///
/// A card may be in at most one open duel at a time (openDuelOfCard); only its current holder may stake it
/// (ownerOf, not approve-based, so nobody else can risk a card on its owner's behalf). Selling a card mid-duel is
/// never blocked here — this contract doesn't touch the card or its stats, and the duel's payout always goes to
/// the wallet that staked it, not whoever holds the card when it settles.
///
/// Every setting that moves money or keys (treasury, signer) waits 48 hours between propose() and execute(), like
/// CardEvolution. The allowed stake amounts, the per-wallet balance cap, maxOpenDuels, maxLockedValue and maxSettlePerHour move at
/// once: none of them can touch money already in play, so the owner can retune them — this was built to start at
/// a single small amount — without a kart release or any delay. Ownership moves in two steps with the same
/// 48-hour wait.
contract StakedDuels is Ownable2Step, EIP712, ReentrancyGuardTransient {
    uint256 public constant TIMELOCK = 48 hours;
    uint256 public constant TIMEOUT = 24 hours;
    uint256 public constant SEED_BLOCKS = 3; // consecutive block hashes combined into the duel's seed
    uint256 public constant FEE_BPS = 750; // 7.5% of each side's stake, so 7.5% of the pot in total
    /// settle() works until block lockBlock + SETTLE_WINDOW, refundTimeout() from the block after it: ~52 minutes at
    /// BSC's 0.45 s blocks, well inside the 8,191 blocks HISTORY serves (and a settle near the end still reads every
    /// seed block: the oldest is SETTLE_WINDOW blocks back)
    uint256 public constant SETTLE_WINDOW = 7000;
    /// EIP-2935's block-hash history: get(n) answers the hash of any of the last 8,191 blocks, written by the chain
    /// itself at the start of every block (BSC mainnet and testnet run the EIP's exact bytecode, read 8 Nov 2026)
    address public constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint256 private constant BLOCKHASH_WINDOW = 256; // blockhash() is 0 for blocks older than this

    enum Setting {
        Treasury,
        Signer
    }

    enum DuelStatus {
        None,
        Locked,
        Settled,
        Refunded
    }

    struct Pending {
        uint256 value;
        uint64 eta; // 0 = nothing pending
    }

    /// Signed off-chain by `player`, free and gasless; consumed at most once (by its own digest).
    /// `opponent` is address(0) for the open table, or one specific wallet for a direct challenge.
    struct Intent {
        address player;
        uint256 cardId;
        uint256 stake;
        address opponent;
        uint256 nonce;
        uint64 expiry;
    }

    struct Duel {
        address playerA;
        address playerB;
        uint256 cardA;
        uint256 cardB;
        uint128 stake; // per side
        uint64 lockBlock;
        uint64 deadline; // refundTimeout() opens after this
        DuelStatus status;
    }

    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "Intent(address player,uint256 cardId,uint256 stake,address opponent,uint256 nonce,uint64 expiry)"
    );
    bytes32 private constant SETTLE_TYPEHASH = keccak256("Settle(uint256 duelId,address winner,bytes32 seed)");
    /// Signed by the server: these two Intents (by digest, in this order) may be paired, under these battle inputs.
    bytes32 private constant MATCH_TYPEHASH = keccak256("Match(bytes32 intentA,bytes32 intentB,bytes32 terms)");

    IERC721 public immutable cards;
    address payable public treasury;
    address public signer;
    bool public paused;
    uint256 public maxBalance; // per-wallet cap on balanceOf
    uint256 public treasuryBalance; // fees owed to treasury, pulled by sweepTreasury()
    uint64 public ownerEta; // when the pending owner may accept

    // A leaked signer can name either side the winner of every duel open at the moment it is used. These two caps
    // bound what is at stake at one moment (openDuelCount <= maxOpenDuels, lockedValue <= maxLockedValue), not the
    // total over time: settled duels free their room within seconds. pause() is what stops a leaked signer.
    uint256 public maxOpenDuels;
    uint256 public maxLockedValue;
    uint256 public openDuelCount;
    uint256 public lockedValue;

    // Hourly cap on the pot value settle() may move, so a leaked signer can only move a small amount an hour
    // (pause is still the real stop). Fixed one-hour windows (block.timestamp / 1 hour): a cap's worth can land
    // at the end of one window and another at the start of the next. A settle that would pass the cap reverts, so
    // the duel waits and refunds as usual if it is not settled in time. Refunds, draws, withdraw and cancelIntent
    // never look at it. Default 0.15 BNB an hour, about 50 duels at 0.0015 BNB a side.
    uint256 public maxSettlePerHour = 0.15 ether;
    uint64 public settleWindow; // hour index of the window settledInWindow counts
    uint192 public settledInWindow; // pot value settled so far in settleWindow

    mapping(address => uint256) public balanceOf;
    mapping(uint256 => bool) public stakeAllowed; // stake amount in wei -> may be used in a new duel
    mapping(bytes32 => bool) public usedIntent; // Intent digest -> consumed
    mapping(uint256 => Duel) public duels;
    mapping(uint256 => uint256) public openDuelOfCard; // cardId -> duel id with an unsettled duel, 0 = free
    mapping(Setting => Pending) public pending;
    uint256 public nextDuelId = 1;

    event Deposited(address indexed player, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed player, uint256 amount, uint256 newBalance);
    event DuelFormed(
        uint256 indexed duelId,
        address indexed playerA,
        address indexed playerB,
        uint256 cardA,
        uint256 cardB,
        uint256 stake,
        uint64 lockBlock,
        uint64 deadline,
        bytes32 terms
    );
    event IntentCancelled(address indexed player, bytes32 digest);
    event Settled(uint256 indexed duelId, address indexed winner, bytes32 seed, uint256 payout, uint256 fee);
    event Refunded(uint256 indexed duelId);
    event TreasurySwept(uint256 amount);
    event PausedSet(bool paused);
    event StakeTierSet(uint256 amount, bool allowed);
    event MaxBalanceSet(uint256 newCap);
    event MaxOpenDuelsSet(uint256 newCap);
    event MaxLockedValueSet(uint256 newCap);
    event MaxSettlePerHourSet(uint256 newCap);
    event SettingProposed(Setting indexed setting, uint256 value, uint64 eta);
    event SettingCancelled(Setting indexed setting);
    event SettingExecuted(Setting indexed setting, uint256 value);
    event OwnershipProposed(address indexed newOwner, uint64 eta);

    error BadAddress();
    error ZeroAmount();
    error ContractPaused();
    error BalanceCapExceeded();
    error InsufficientBalance();
    error PaymentFailed();
    error ExpiredIntent();
    error UsedIntent();
    error BadIntentSignature();
    error BadMatchSignature();
    error NotIntentPlayer();
    error NotCardHolder();
    error StakeNotAllowed();
    error StakeMismatch();
    error OpponentMismatch();
    error CardBusy();
    error SamePlayer();
    error TooManyOpenDuels();
    error LockedValueCapExceeded();
    error HourlySettleCapExceeded();
    error DuelNotLocked();
    error SeedUnavailable();
    error BadWinner();
    error BadSettleSignature();
    error TimeoutNotReached();
    error NotReady();
    error NoRenounce();
    error NoBlockHashHistory();

    constructor(
        address owner_,
        IERC721 cards_,
        address payable treasury_,
        address signer_,
        uint256 firstStakeWei,
        uint256 maxBalance_,
        uint256 maxOpenDuels_,
        uint256 maxLockedValue_
    ) Ownable(owner_) EIP712("StakedDuels", "1") {
        if (address(cards_) == address(0) || treasury_ == address(0) || signer_ == address(0)) revert BadAddress();
        if (firstStakeWei == 0 || maxBalance_ == 0 || maxOpenDuels_ == 0 || maxLockedValue_ == 0) revert ZeroAmount();
        // a chain without EIP-2935 could settle for 256 blocks only, yet refund only after SETTLE_WINDOW: not here
        if (HISTORY.code.length == 0) revert NoBlockHashHistory();
        cards = cards_;
        treasury = treasury_;
        signer = signer_;
        maxBalance = maxBalance_;
        maxOpenDuels = maxOpenDuels_;
        maxLockedValue = maxLockedValue_;
        stakeAllowed[firstStakeWei] = true;
        emit StakeTierSet(firstStakeWei, true);
    }

    /// Adds `msg.value` to the caller's balance, capped at maxBalance. Free money, never locked until formDuel.
    function deposit() external payable {
        if (paused) revert ContractPaused();
        if (msg.value == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender] + msg.value;
        if (bal > maxBalance) revert BalanceCapExceeded();
        balanceOf[msg.sender] = bal;
        emit Deposited(msg.sender, msg.value, bal);
    }

    /// Pays the caller from their own balance, any time, paused or not: nothing here ever needs the server's help
    /// to get money back out, as long as it isn't currently locked in an open duel.
    function withdraw(uint256 amount) external nonReentrant {
        uint256 bal = balanceOf[msg.sender];
        if (amount == 0 || amount > bal) revert InsufficientBalance();
        uint256 left = bal - amount;
        balanceOf[msg.sender] = left;
        emit Withdrawn(msg.sender, amount, left);
        _send(payable(msg.sender), amount);
    }

    /// Locks both Intents' stakes into a new duel. Anyone may send it (normally our matchmaker, paying its own
    /// gas): the players' signatures authorize their money, and the server's Match signature over this exact
    /// pairing and `terms` (the hash of the battle inputs it will simulate with, besides the seed) authorizes who
    /// meets whom. Copying a pending formDuel only forms the same duel the server chose.
    function formDuel(
        Intent calldata a,
        bytes calldata sigA,
        Intent calldata b,
        bytes calldata sigB,
        bytes32 terms,
        bytes calldata matchSig
    ) external returns (uint256 duelId) {
        if (paused) revert ContractPaused();
        if (a.player == b.player) revert SamePlayer();
        if (a.stake != b.stake) revert StakeMismatch();
        if (!stakeAllowed[a.stake]) revert StakeNotAllowed();
        if (a.opponent != address(0) && a.opponent != b.player) revert OpponentMismatch();
        if (b.opponent != address(0) && b.opponent != a.player) revert OpponentMismatch();
        bytes32 digestA = _consumeIntent(a, sigA);
        bytes32 digestB = _consumeIntent(b, sigB);
        bytes32 matchDigest = _hashTypedDataV4(keccak256(abi.encode(MATCH_TYPEHASH, digestA, digestB, terms)));
        if (ECDSA.recover(matchDigest, matchSig) != signer) revert BadMatchSignature();
        if (cards.ownerOf(a.cardId) != a.player || cards.ownerOf(b.cardId) != b.player) revert NotCardHolder();
        if (openDuelOfCard[a.cardId] != 0 || openDuelOfCard[b.cardId] != 0) revert CardBusy();
        if (openDuelCount >= maxOpenDuels) revert TooManyOpenDuels();
        uint256 pot = a.stake * 2;
        uint256 newLockedValue = lockedValue + pot;
        if (newLockedValue > maxLockedValue) revert LockedValueCapExceeded();

        uint256 balA = balanceOf[a.player];
        uint256 balB = balanceOf[b.player];
        if (balA < a.stake) revert InsufficientBalance();
        if (balB < b.stake) revert InsufficientBalance();
        balanceOf[a.player] = balA - a.stake;
        balanceOf[b.player] = balB - b.stake;
        openDuelCount++;
        lockedValue = newLockedValue;

        duelId = nextDuelId++;
        uint64 lockBlock = uint64(block.number + 1);
        uint64 deadline = uint64(block.timestamp + TIMEOUT);
        duels[duelId] = Duel(a.player, b.player, a.cardId, b.cardId, uint128(a.stake), lockBlock, deadline, DuelStatus.Locked);
        openDuelOfCard[a.cardId] = duelId;
        openDuelOfCard[b.cardId] = duelId;
        emit DuelFormed(duelId, a.player, b.player, a.cardId, b.cardId, a.stake, lockBlock, deadline, terms);
    }

    /// Marks one of the caller's own signed Intents as used, so it can never lock money. Works while paused.
    function cancelIntent(Intent calldata v) external {
        if (msg.sender != v.player) revert NotIntentPlayer();
        bytes32 digest = intentDigest(v);
        usedIntent[digest] = true;
        emit IntentCancelled(msg.sender, digest);
    }

    /// Pays the winner the pot minus the cut (7.5% of each side's stake), once the seed this contract itself reads
    /// from the chain is signed off on by the server. winner == address(0) is a draw, signed the same way: each side
    /// gets its full stake back with no cut, the duel ends Refunded (the Refunded event, no Settled), and the hourly
    /// cap isn't used, since no money leaves anyone. Works from block lockBlock + SEED_BLOCKS to lockBlock +
    /// SETTLE_WINDOW; outside it, or if the chain can't serve a seed block, reverts SeedUnavailable (towards
    /// refundTimeout, never towards trusting a different seed).
    function settle(uint256 duelId, address winner, bytes calldata sig) external nonReentrant {
        if (paused) revert ContractPaused();
        Duel storage d = duels[duelId];
        if (d.status != DuelStatus.Locked) revert DuelNotLocked();
        if (winner != address(0) && winner != d.playerA && winner != d.playerB) revert BadWinner();

        bytes32 seed = _seedOrZero(d.lockBlock);
        if (seed == bytes32(0)) revert SeedUnavailable();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SETTLE_TYPEHASH, duelId, winner, seed)));
        if (ECDSA.recover(digest, sig) != signer) revert BadSettleSignature();

        if (winner == address(0)) {
            _refund(duelId, d);
            return;
        }

        uint256 pot = uint256(d.stake) * 2;
        uint64 window = uint64(block.timestamp / 1 hours);
        uint256 settledNow = window == settleWindow ? settledInWindow : 0;
        settledNow += pot;
        if (settledNow > maxSettlePerHour) revert HourlySettleCapExceeded();
        settleWindow = window;
        settledInWindow = uint192(settledNow);

        d.status = DuelStatus.Settled;
        openDuelOfCard[d.cardA] = 0;
        openDuelOfCard[d.cardB] = 0;
        openDuelCount--;

        lockedValue -= pot;
        uint256 fee = ((uint256(d.stake) * FEE_BPS) / 10_000) * 2; // 7.5% from each side, rounded down per side
        uint256 payout = pot - fee; // payout + fee == pot, always
        treasuryBalance += fee;
        balanceOf[winner] += payout;
        emit Settled(duelId, winner, seed, payout, fee);
    }

    /// Either side's stake is theirs again, no signature, no server, once the duel can no longer be settled
    /// (from block lockBlock + SETTLE_WINDOW + 1, ~52 minutes after the lock on BSC) or 24 hours have passed since
    /// it locked, whichever comes first. Never while settle() could still be mined: a loser who saw the reveal
    /// can't take their stake back before the winner is paid. Anyone may call it. Works even while paused.
    function refundTimeout(uint256 duelId) external nonReentrant {
        Duel storage d = duels[duelId];
        if (d.status != DuelStatus.Locked) revert DuelNotLocked();
        if (block.timestamp <= d.deadline && block.number <= uint256(d.lockBlock) + SETTLE_WINDOW) {
            revert TimeoutNotReached();
        }
        _refund(duelId, d);
    }

    /// Sends every fee collected so far to the fixed treasury address. Permissionless and pull-based on purpose:
    /// a treasury that can't receive BNB must never be able to block a single settle().
    function sweepTreasury() external nonReentrant {
        uint256 amt = treasuryBalance;
        if (amt == 0) revert ZeroAmount();
        treasuryBalance = 0;
        emit TreasurySwept(amt);
        _send(treasury, amt);
    }

    function intentDigest(Intent calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(INTENT_TYPEHASH, v.player, v.cardId, v.stake, v.opponent, v.nonce, v.expiry))
        );
    }

    /// The seed settle() will require a signature over, while it would take one: 0 before the seed blocks are all
    /// mined, and 0 for good after block lockBlock + SETTLE_WINDOW (refundTimeout is open then).
    function seedOf(uint256 duelId) external view returns (bytes32) {
        Duel storage d = duels[duelId];
        if (d.lockBlock == 0) return bytes32(0);
        return _seedOrZero(d.lockBlock);
    }

    /// Stops new deposits, new duels and new settlements at once. refundTimeout and withdraw never stop: pausing
    /// means "stop trusting the signer and stop taking new money", not "freeze everyone's balance".
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// Adds or drops one stake amount from the allowed list. Instant: it only ever affects duels formed after
    /// this call, never money already locked, so there is nothing for a 48-hour wait to protect here.
    function setStakeAllowed(uint256 wei_, bool allowed_) external onlyOwner {
        if (wei_ == 0) revert ZeroAmount();
        stakeAllowed[wei_] = allowed_;
        emit StakeTierSet(wei_, allowed_);
    }

    /// Changes the per-wallet balance cap. Instant, same reasoning: it only bounds future deposits.
    function setMaxBalance(uint256 newCap) external onlyOwner {
        if (newCap == 0) revert ZeroAmount();
        maxBalance = newCap;
        emit MaxBalanceSet(newCap);
    }

    /// Changes the global cap on simultaneously open duels. Instant: it only gates new formDuel calls and never
    /// touches a duel already locked. It limits what is at stake at one moment, not in total — pause for that.
    function setMaxOpenDuels(uint256 newCap) external onlyOwner {
        if (newCap == 0) revert ZeroAmount();
        maxOpenDuels = newCap;
        emit MaxOpenDuelsSet(newCap);
    }

    /// Changes the global cap on total value locked across open duels at once. Instant, same reasoning as
    /// maxOpenDuels: it only gates new formDuel calls, never unwinds money already locked.
    function setMaxLockedValue(uint256 newCap) external onlyOwner {
        if (newCap == 0) revert ZeroAmount();
        maxLockedValue = newCap;
        emit MaxLockedValueSet(newCap);
    }

    /// Changes the hourly cap on pot value settled. Instant, same reasoning: it only gates future settle() calls
    /// (a blocked duel just waits or refunds) and never touches money, refunds or withdrawals.
    function setMaxSettlePerHour(uint256 newCap) external onlyOwner {
        if (newCap == 0) revert ZeroAmount();
        maxSettlePerHour = newCap;
        emit MaxSettlePerHourSet(newCap);
    }

    /// Starts the 48-hour wait for a new treasury or signer (the address as uint256), replacing one pending.
    function propose(Setting setting, uint256 value) external onlyOwner {
        if (value == 0 || value > type(uint160).max) revert BadAddress();
        uint64 eta = uint64(block.timestamp + TIMELOCK);
        pending[setting] = Pending(value, eta);
        emit SettingProposed(setting, value, eta);
    }

    function cancel(Setting setting) external onlyOwner {
        if (pending[setting].eta == 0) return;
        delete pending[setting];
        emit SettingCancelled(setting);
    }

    function execute(Setting setting) external onlyOwner {
        Pending memory p = pending[setting];
        if (p.eta == 0 || block.timestamp < p.eta) revert NotReady();
        delete pending[setting];
        if (setting == Setting.Treasury) treasury = payable(address(uint160(p.value)));
        else signer = address(uint160(p.value));
        emit SettingExecuted(setting, p.value);
    }

    /// A new owner waits 48 hours too, as on the other Agent Cards contracts.
    function transferOwnership(address newOwner) public override onlyOwner {
        super.transferOwnership(newOwner);
        ownerEta = newOwner == address(0) ? 0 : uint64(block.timestamp + TIMELOCK);
        emit OwnershipProposed(newOwner, ownerEta);
    }

    function acceptOwnership() public override {
        if (ownerEta == 0 || block.timestamp < ownerEta) revert NotReady();
        ownerEta = 0;
        super.acceptOwnership();
    }

    /// Giving up ownership would strand every open duel: nobody could rotate a leaked signer or move the treasury.
    function renounceOwnership() public pure override {
        revert NoRenounce();
    }

    /// A new owner starts clean: a proposal queued under the previous owner is never inherited.
    function _transferOwnership(address newOwner) internal override {
        delete pending[Setting.Treasury];
        delete pending[Setting.Signer];
        super._transferOwnership(newOwner);
    }

    /// Ends a locked duel with each side's stake back in its balance: a draw (settle) or refundTimeout.
    function _refund(uint256 duelId, Duel storage d) private {
        d.status = DuelStatus.Refunded;
        openDuelOfCard[d.cardA] = 0;
        openDuelOfCard[d.cardB] = 0;
        openDuelCount--;
        lockedValue -= uint256(d.stake) * 2;
        balanceOf[d.playerA] += d.stake;
        balanceOf[d.playerB] += d.stake;
        emit Refunded(duelId);
    }

    function _consumeIntent(Intent calldata v, bytes calldata sig) private returns (bytes32 digest) {
        if (block.timestamp > v.expiry) revert ExpiredIntent();
        digest = intentDigest(v);
        if (usedIntent[digest]) revert UsedIntent();
        usedIntent[digest] = true;
        if (ECDSA.recover(digest, sig) != v.player) revert BadIntentSignature();
    }

    /// The hashes of blocks lockBlock .. lockBlock + SEED_BLOCKS - 1, combined; 0 before the last of them is mined,
    /// after block lockBlock + SETTLE_WINDOW, or when the chain can't serve one of them. A hash older than 256 blocks
    /// comes from HISTORY, and only while HISTORY's record of the previous block is that block's real hash: a
    /// history that stopped being written would hand back the hash of a block 8,191 earlier, known long before the
    /// lock, so the seed could be worked out in advance.
    function _seedOrZero(uint64 lockBlock) internal view returns (bytes32) {
        uint256 first = lockBlock;
        if (block.number < first + SEED_BLOCKS || block.number > first + SETTLE_WINDOW) return bytes32(0);
        if (block.number - first > BLOCKHASH_WINDOW && _history(block.number - 1) != blockhash(block.number - 1)) {
            return bytes32(0);
        }
        bytes32[] memory hashes = new bytes32[](SEED_BLOCKS);
        for (uint256 i = 0; i < SEED_BLOCKS; i++) {
            bytes32 h = blockhash(first + i);
            if (h == bytes32(0)) h = _history(first + i);
            if (h == bytes32(0)) return bytes32(0);
            hashes[i] = h;
        }
        return keccak256(abi.encode(hashes));
    }

    /// HISTORY's hash of block `n`, or 0: it reverts for a block outside its last 8,191, and a chain without it has
    /// no code there (an empty answer).
    function _history(uint256 n) internal view returns (bytes32 h) {
        (bool ok, bytes memory ret) = HISTORY.staticcall(abi.encode(n));
        if (ok && ret.length == 32) h = abi.decode(ret, (bytes32));
    }

    function _send(address payable to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PaymentFailed();
    }
}
