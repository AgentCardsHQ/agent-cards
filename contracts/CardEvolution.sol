// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title Card evolution for Agent Cards
/// A card's holder pays to move it one stage up, with a short-lived voucher the game server signs: the server checks the
/// level the card has earned by playing and decides the price (a discount lives only there), and this contract checks
/// who sends it, which stage comes next, that the side never changes and that the price stays within the owner's limit.
/// The stage and side stay with the card when it is sold. The contract holds no money: every payment goes straight to
/// the treasury in the same transaction. A leaked signer can't charge more than the limit, can't act for anyone but the
/// wallet that sends the transaction, and can't move a card back; the owner can pause at once and replace the signer.
/// The treasury, the signer and the price limits wait 48 hours between propose() and execute().
contract CardEvolution is Ownable2Step, EIP712, ReentrancyGuardTransient {
    uint8 public constant LIGHT = 1;
    uint8 public constant DARK = 2;
    uint256 public constant TIMELOCK = 48 hours;

    /// `holder` must send the transaction and hold card `id`; `expiry` is a unix time.
    struct Voucher {
        address holder;
        uint256 id;
        uint8 stage;
        uint8 side;
        uint256 price;
        uint64 expiry;
    }

    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("Voucher(address holder,uint256 id,uint8 stage,uint8 side,uint256 price,uint64 expiry)");

    /// MaxPrice proposals carry the stage they are for; the others use stage 0.
    enum Setting {
        Treasury,
        Signer,
        MaxPrice
    }

    struct Pending {
        uint256 value;
        uint64 eta;
    }

    IERC721 public immutable cards;
    address payable public treasury;
    address public signer;
    bool public paused;
    uint64 public ownerEta; // when the pending owner may accept
    /// The most a stage can cost, in wei; 0 = the stage isn't open.
    mapping(uint8 stage => uint256) public maxPrice;
    mapping(uint256 id => uint8) public stageOf;
    /// LIGHT or DARK, fixed by the card's first evolution; 0 before it.
    mapping(uint256 id => uint8) public sideOf;
    mapping(Setting setting => mapping(uint8 stage => Pending)) public pending;
    uint8 private highestProposed; // the highest stage a price limit was proposed for: how far a new owner's clean-up goes

    event Evolved(uint256 indexed id, uint8 indexed stage, uint8 side, address indexed holder, uint256 price);
    event SettingProposed(Setting indexed setting, uint8 indexed stage, uint256 value, uint64 eta);
    event SettingCancelled(Setting indexed setting, uint8 indexed stage);
    event SettingExecuted(Setting indexed setting, uint8 indexed stage, uint256 value);
    event PausedSet(bool paused);
    event OwnershipProposed(address indexed newOwner, uint64 eta);

    error BadAddress();
    error BadSetting();
    error BadSignature();
    error BadSide();
    error Expired();
    error NoRenounce();
    error NotHolder();
    error NotReady();
    error PaymentFailed();
    error PriceTooHigh();
    error StageClosed();
    error VoucherPaused();
    error WrongPayment();
    error WrongStage();

    constructor(address owner_, IERC721 cards_, address payable treasury_, address signer_, uint256 firstStageMaxPrice)
        Ownable(owner_)
        EIP712("CardEvolution", "1")
    {
        if (address(cards_) == address(0) || treasury_ == address(0) || signer_ == address(0)) revert BadAddress();
        cards = cards_;
        treasury = treasury_;
        signer = signer_;
        maxPrice[1] = firstStageMaxPrice;
    }

    /// Pays the voucher's price and moves the card one stage up.
    function evolve(Voucher calldata v, bytes calldata sig) external payable nonReentrant {
        if (paused) revert VoucherPaused();
        if (block.timestamp > v.expiry) revert Expired();
        if (v.holder != msg.sender || cards.ownerOf(v.id) != msg.sender) revert NotHolder();
        if (v.stage != stageOf[v.id] + 1) revert WrongStage();
        uint256 limit = maxPrice[v.stage]; // 0 until the owner opens the stage
        if (limit == 0) revert StageClosed();
        if (v.price > limit) revert PriceTooHigh();
        if (msg.value != v.price) revert WrongPayment();
        if (v.side != LIGHT && v.side != DARK) revert BadSide();
        if (v.stage > 1 && v.side != sideOf[v.id]) revert BadSide();
        if (ECDSA.recover(voucherDigest(v), sig) != signer) revert BadSignature();

        stageOf[v.id] = v.stage;
        sideOf[v.id] = v.side;
        emit Evolved(v.id, v.stage, v.side, msg.sender, v.price);
        (bool ok, ) = treasury.call{value: msg.value}("");
        if (!ok) revert PaymentFailed();
    }

    function voucherDigest(Voucher calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, v.holder, v.id, v.stage, v.side, v.price, v.expiry)));
    }

    /// Stops or reopens evolving, at once (say, a leaked signer while its replacement waits its 48 hours).
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// Starts the 48-hour wait for a new treasury or signer (the address as uint256), replacing one pending.
    function propose(Setting setting, uint256 value) external onlyOwner {
        if (setting == Setting.MaxPrice) revert BadSetting(); // it needs the stage: proposeMaxPrice
        if (value == 0 || value > type(uint160).max) revert BadAddress();
        _propose(setting, 0, value);
    }

    /// Starts the 48-hour wait for `stage`'s price limit (wei, 0 closes the stage), replacing one pending.
    function proposeMaxPrice(uint8 stage, uint256 price) external onlyOwner {
        if (stage == 0) revert WrongStage();
        if (stage > highestProposed) highestProposed = stage;
        _propose(Setting.MaxPrice, stage, price);
    }

    /// Drops a proposal; `stage` is 0 for the treasury and the signer.
    function cancel(Setting setting, uint8 stage) external onlyOwner {
        if (pending[setting][stage].eta == 0) return;
        delete pending[setting][stage];
        emit SettingCancelled(setting, stage);
    }

    /// Applies a proposal once its 48 hours have passed; `stage` is 0 for the treasury and the signer.
    function execute(Setting setting, uint8 stage) external onlyOwner {
        Pending memory p = pending[setting][stage];
        if (p.eta == 0 || block.timestamp < p.eta) revert NotReady();
        delete pending[setting][stage];
        if (setting == Setting.Treasury) treasury = payable(address(uint160(p.value)));
        else if (setting == Setting.Signer) signer = address(uint160(p.value));
        else maxPrice[stage] = p.value;
        emit SettingExecuted(setting, stage, p.value);
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
        super.acceptOwnership(); // only the pending owner
    }

    function renounceOwnership() public pure override {
        revert NoRenounce();
    }

    /// A new owner starts clean: proposals queued under the previous owner are dropped, never inherited.
    function _transferOwnership(address newOwner) internal override {
        delete pending[Setting.Treasury][0];
        delete pending[Setting.Signer][0];
        for (uint256 s = 1; s <= highestProposed; s++) delete pending[Setting.MaxPrice][uint8(s)];
        super._transferOwnership(newOwner);
    }

    function _propose(Setting setting, uint8 stage, uint256 value) private {
        uint64 eta = uint64(block.timestamp + TIMELOCK);
        pending[setting][stage] = Pending(value, eta);
        emit SettingProposed(setting, stage, value, eta);
    }
}
