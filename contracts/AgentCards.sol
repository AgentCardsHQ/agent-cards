// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Card, Edition, ICardRenderer} from "./CardTypes.sol";

/// @title Agent Cards
/// @notice One free card per Binance Agent ID, minted by the wallet that holds the ID. Our server signs the
/// starting stats, the role the agent picked and a secret roll fixed per Agent ID; the roll and how early the
/// card is minted decide its rarity. The card is a game character: its level lives on the token, only goes up
/// and moves with it when sold. Art and metadata come from a swappable renderer.
/// Paid extras (packs of extra arena fights, the season pass) have fixed prices and no randomness. Holo and frames
/// are never sold: no function here takes a payment for them, they are only granted for free as upkeep (Holo is
/// earned: season prizes, the wheel, early pre-registrations). Cards can also be sold on the built-in market, which
/// takes a fee and pays the royalty on every sale it makes (other marketplaces decide for themselves whether to
/// honour ERC-2981). Every payment is forwarded in the same transaction, so this contract never holds funds.
/// Mythic cards are limited, numbered series on top of that: anyone can buy the next copy of a design at its
/// fixed price, and a small reserve per design goes to free wheel prizes through the server's vouchers.
/// Settings that move money or keys (treasury, both signers, renderer, market fee, operator) wait 48 hours between
/// proposal and use, and ownership moves in two steps with the same wait, so a tricked or stolen owner key can't
/// redirect anything unnoticed. Prices wait the same 48 hours once cards exist: the owner's launch prices (a fight
/// pack, the season pass, each Mythic design) apply at once only while no card exists, and from the first card on
/// every price change, up, down or off sale, is proposed in the open first (SettingProposed, allPending). The owner
/// is a human-held wallet; day-to-day upkeep (holo airdrops, wheel prizes, shrinking a Mythic reserve, pausing the
/// mint or level updates) goes through a separate operator, the AI agent's wallet, which can't touch money, prices,
/// keys or ownership. The owner can revoke the operator at once.
contract AgentCards is ERC721, ERC2981, Ownable2Step, EIP712, ReentrancyGuardTransient {
    bytes32 private constant STATS_TYPEHASH = keccak256(
        "Stats(address wallet,string label,uint8 power,uint8 defense,uint8 speed,uint8 luck,uint8 role,uint8 region,uint32 badges,uint32 roll,uint64 issuedAt,uint64 expiry)"
    );
    bytes32 private constant UPDATE_TYPEHASH =
        keccak256("Update(uint256 id,uint16 level,uint32 badges,uint64 issuedAt,uint64 expiry)");
    bytes32 private constant MYTHIC_CLAIM_TYPEHASH =
        keccak256("MythicClaim(address to,uint256 design,uint256 nonce,uint64 expiry)");
    /// Mythic cards have their own ids, MYTHIC_BASE + design * 1,000 + copy number (design 1's copy 7 is 1,001,007),
    /// so they never take the early card numbers that decide the mint's rarity odds. Agent ID cards stay below it.
    uint256 public constant MYTHIC_BASE = 1_000_000;
    /// Genesis is the first 10,000 Agent ID cards (card numbers 1 to 10,000), a number nothing can change. Each further
    /// 10,000 cards is the next series (Series 2 from card 10,001), minted free the same way.
    uint256 public constant GENESIS_SUPPLY = 10_000;
    /// Founders are the first 1,000 Agent ID cards (card numbers 1 to 1,000), a smaller mark inside Genesis that
    /// nothing can change either.
    uint256 public constant FOUNDERS = 1_000;
    uint8 private constant MYTHIC = 4; // the rarity of Mythic cards
    uint256 private constant MAX_COPIES = 999; // per design, so copy numbers fit the id scheme
    uint256 private constant MAX_MYTHIC_NAME = 32;
    uint96 private constant ROYALTY_BPS = 500; // 5%
    uint8 private constant MINT_ROLES = 4; // Warrior, Priest, Mage, Assassin
    uint8 private constant MAX_REGION = 15;
    uint256 private constant MAX_LABEL = 29; // so the stored name, label + ".ai", fits in 32 bytes
    uint256 private constant AWAKEN_PERCENT = 30; // share of Epic and Legendary cards minted awakened
    // The level a card shows can run at most this far ahead of its age; the fastest paying players stay well below.
    uint256 private constant START_LEVEL_CAP = 10;
    uint256 private constant LEVELS_PER_DAY = 4;
    // ...and never past the game's top level, however old the card is, so even a leaked signer can't write super levels.
    uint256 private constant MAX_LEVEL = 50;
    uint16 private constant MAX_MARKET_FEE_BPS = 1000; // the market fee can never go above 10%
    // The most a minted card can total: 200 shaped points, +2 per stat for a verified pre-registration and the role's
    // +18. Signed mint stats and Mythic designs can't go past it, so even a leaked server key can't mint super cards.
    uint256 private constant MAX_STAT_TOTAL = 226;
    uint256 public constant TIMELOCK = 48 hours;
    uint256 private constant MAX_UPDATE_AHEAD = 1 hours; // how far a level update's issuedAt may run ahead of the chain

    /// Settings that wait TIMELOCK between propose() and execute(): addresses as uint256, the market fee in bps and
    /// prices in wei (0 = not for sale). Prices wait only once a card exists (see setFightPackPrice), and a lower price
    /// waits like a higher one. MythicPrice is one design's price, so its proposals carry the design's id
    /// (proposeMythicPrice, cancelMythicPrice, executeMythicPrice).
    enum Setting {
        Treasury,
        Signer,
        VoucherSigner,
        Renderer,
        MarketFee,
        Operator,
        FightPackPrice,
        PassPrice,
        MythicPrice
    }

    struct Pending {
        uint256 value;
        uint64 eta; // 0 = nothing pending
    }

    /// Signed at mint: which Agent ID this is, the role it picked, its starting stats and its secret roll.
    struct Stats {
        address wallet;
        string label; // the Agent ID without ".ai"; its token id in the registry is uint256(keccak256(label))
        uint8 power;
        uint8 defense;
        uint8 speed;
        uint8 luck;
        uint8 role;
        uint8 region;
        uint32 badges;
        uint32 roll; // the server's secret roll for this Agent ID: last 4 digits pick rarity, the 2 before awakening
        uint64 issuedAt;
        uint64 expiry;
    }

    /// Signed by the game server for an existing card: its level (never lower) and badges.
    struct Update {
        uint256 id;
        uint16 level;
        uint32 badges;
        uint64 issuedAt;
        uint64 expiry;
    }

    /// A Mythic design: one character with fixed stats, sold copy by copy at a fixed price, plus a reserve the free
    /// wheel gives away. Its supply can only ever shrink, so a series stays as limited as it was announced.
    struct Mythic {
        string name;
        uint8 region;
        uint8 role;
        uint8 season;
        bool open; // on sale
        uint8 power;
        uint8 defense;
        uint8 speed;
        uint8 luck;
        uint16 saleSupply;
        uint16 sold;
        uint16 wheelReserve;
        uint16 awarded; // wheel copies claimed
        uint256 price;
    }

    /// Signed by the game server for a free wheel win: one reserve copy of `design` for `to`, claimable once.
    struct MythicClaim {
        address to;
        uint256 design;
        uint256 nonce;
        uint64 expiry;
    }

    IERC721 public immutable agentRegistry; // SPACE ID Agent ID on BSC
    address public signer; // signs mint stats and level updates
    address public voucherSigner; // signs only wheel Mythic vouchers, so one leaked key can't do both
    address public operator; // routine upkeep only (see onlyOperator); 0 = none
    address payable public treasury;
    ICardRenderer public renderer;
    bool public mintOpen = true;
    bool public updatesOpen = true; // signed level updates; the operator can pause them at once (a leaked signer)
    uint16 public openRegions = 15; // bit per region (1 West, 2 East, 4 North, 8 South); all four open from Season 0
    uint256 public fightPackPrice; // one pack of extra arena fights; 0 = not for sale
    uint256 public passPrice; // a season pass of extra daily arena fights for one card; 0 = not for sale
    uint16 public marketFeeBps = 250; // 2.5% of every sale on the built-in market, on top of the 5% royalty
    // Agent ID cards only: it numbers them and sets their mint odds. Mythic copies are counted per design;
    // totalCards() adds them up.
    uint256 public totalSupply;
    uint256 public mythicDesigns; // designs are numbered from 1

    mapping(uint256 => Card) private _cards;
    mapping(uint256 => uint256) public cardOfAgentId; // Agent ID token id -> card id (ids start at 1)
    mapping(uint256 => uint256) public priceOf; // built-in market: asking price; 0 = not for sale
    mapping(uint256 => Mythic) public mythics;
    mapping(uint256 => bool) public claimUsed; // MythicClaim nonce -> spent
    // timelocked changes waiting for execute(), by setting and design: the Mythic design for MythicPrice, else 0
    mapping(Setting => mapping(uint256 => Pending)) public pending;
    uint64 public ownerEta; // when a started ownership transfer may be accepted; 0 = none started

    event CardMinted(
        uint256 indexed id, address indexed agent, uint256 indexed agentId, string name, uint8 rarity, bool awakened
    );
    event CardUpdated(uint256 indexed id, uint16 level);
    event HoloApplied(uint256 indexed id, address indexed by);
    event FrameApplied(uint256 indexed id, uint16 frame);
    event FightsBought(uint256 indexed id, address indexed payer, uint16 packs);
    event PassBought(uint256 indexed id, address indexed payer, uint256 price);
    event Listed(uint256 indexed id, address indexed seller, uint256 price);
    event Sold(uint256 indexed id, address indexed seller, address indexed buyer, uint256 price);
    event MythicAdded(uint256 indexed design, string name, uint16 supply, uint256 price);
    event MythicMinted(uint256 indexed id, uint256 indexed design, address indexed to, uint16 number, bool wheel);
    event MythicSaleSet(uint256 indexed design, uint256 price, bool open);
    event MythicCapped(uint256 indexed design, uint16 saleSupply, uint16 wheelReserve);
    /// A timelocked change, proposed, cancelled or applied; `design` is the Mythic design for MythicPrice, else 0.
    event SettingProposed(Setting indexed setting, uint256 indexed design, uint256 value, uint64 eta);
    event SettingCancelled(Setting indexed setting, uint256 indexed design);
    event OwnershipProposed(address indexed newOwner, uint64 eta);
    event SettingChanged(Setting indexed setting, uint256 indexed design, uint256 value);
    /// Every other owner setting, applied at once: key names it ("mintOpen", "openRegions", the launch prices
    /// "fightPackPrice" and "passPrice", ...).
    event ConfigSet(bytes32 indexed key, uint256 a, uint256 b);

    error NotAgent();
    error MintClosed();
    error AlreadyMinted();
    error BadSignature();
    error Expired();
    error BadStats();
    error BadName();
    error BadLevel();
    error NotCardOwner();
    error StaleUpdate();
    error WrongPrice();
    error PaymentFailed();
    error RegionClosed();
    error OwnCard();
    error FeeTooHigh();
    error SoldOut();
    error NoSuchDesign();
    error SaleClosed();
    error ClaimUsed();
    error BadSupply();
    error BadFrame();
    error FutureUpdate();
    error NotReady();
    error Timelocked();
    error BadSetting();
    error RenounceDisabled();
    error NotOperator();
    error UpdatesClosed();

    /// The owner or the operator: only for upkeep that moves no money and changes no price, key or ownership.
    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner()) revert NotOperator();
        _;
    }

    constructor(
        address owner_,
        address operator_,
        address payable treasury_,
        address signer_,
        address voucherSigner_,
        IERC721 registry_,
        ICardRenderer renderer_
    ) ERC721("Agent Cards", "ACARD") Ownable(owner_) EIP712("AgentCards", "1") {
        // owner is passed in because the contract is deployed through a CREATE2 factory
        operator = operator_;
        treasury = treasury_;
        signer = signer_;
        voucherSigner = voucherSigner_;
        agentRegistry = registry_;
        renderer = renderer_;
        _setDefaultRoyalty(treasury_, ROYALTY_BPS);
    }

    // ------------------------------------------------------------------ players

    function mint(Stats calldata s, bytes calldata sig) external returns (uint256 id) {
        if (!mintOpen) revert MintClosed();
        _checkLabel(s.label);
        uint256 agentId = uint256(keccak256(bytes(s.label)));
        if (s.wallet != msg.sender || !_holdsAgentId(agentId)) revert NotAgent();
        if (cardOfAgentId[agentId] != 0) revert AlreadyMinted();
        _checkFresh(s.expiry);
        if (ECDSA.recover(statsDigest(s), sig) != signer) revert BadSignature();
        _checkStats(s.power, s.defense, s.speed, s.luck);
        if (s.role == 0 || s.role > MINT_ROLES) revert BadStats();
        if (s.region > MAX_REGION || (openRegions >> s.region) & 1 == 0) revert RegionClosed();

        id = ++totalSupply;
        if (id >= MYTHIC_BASE) revert SoldOut(); // the ids above belong to Mythic series
        cardOfAgentId[agentId] = id;
        Card storage c = _cards[id];
        c.name = string.concat(s.label, ".ai");
        c.agent = msg.sender;
        c.power = s.power;
        c.defense = s.defense;
        c.speed = s.speed;
        c.luck = s.luck;
        c.role = s.role;
        c.region = s.region;
        c.badges = s.badges;
        c.level = 1;
        c.mintedAt = uint64(block.timestamp);
        c.updatedAt = uint64(block.timestamp);
        (c.rarity, c.awakened) = rarityOf(s.roll, id);
        _safeMint(msg.sender, id);
        emit CardMinted(id, msg.sender, agentId, c.name, c.rarity, c.awakened);
    }

    /// Writes a card's level from the game server. Only the current holder can submit it, only an update
    /// issued after the last one (and not dated in the future, which would freeze the card's level), and the
    /// level never drops, runs ahead of the card's age or passes the game's top level, so even a leaked server key
    /// can't roll a card back or turn out super cards; the operator can also pause updates at once.
    function update(Update calldata u, bytes calldata sig) external {
        if (!updatesOpen) revert UpdatesClosed();
        if (ownerOf(u.id) != msg.sender) revert NotCardOwner();
        Card storage c = _cards[u.id];
        if (u.issuedAt <= c.updatedAt) revert StaleUpdate();
        if (u.issuedAt > block.timestamp + MAX_UPDATE_AHEAD) revert FutureUpdate();
        _checkFresh(u.expiry);
        if (ECDSA.recover(updateDigest(u), sig) != signer) revert BadSignature();
        if (u.level < c.level || u.level > _levelCap(c)) revert BadLevel();

        c.level = u.level;
        c.badges = u.badges;
        c.updatedAt = u.issuedAt;
        emit CardUpdated(u.id, u.level);
    }

    /// Packs of extra arena fights for a card; anyone may buy them (gifts included). The game server credits them
    /// from this event, and paid fights give the same XP whatever the result, so the price buys play, not luck.
    function buyFights(uint256 id, uint16 packs) external payable nonReentrant {
        _requireOwned(id);
        if (packs == 0 || fightPackPrice == 0 || msg.value != fightPackPrice * packs) revert WrongPrice();
        _pay();
        emit FightsBought(id, msg.sender, packs);
    }

    /// A season pass for a card: the game server credits extra fights every day for a while from this event.
    /// Like fight packs it buys play, never luck: pass fights give fixed XP and no wheel tickets.
    function buyPass(uint256 id) external payable nonReentrant {
        _requireOwned(id);
        if (passPrice == 0 || msg.value != passPrice) revert WrongPrice();
        _pay();
        emit PassBought(id, msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ built-in market

    /// Puts your card up for sale at `price` (0 takes it off). A card that changes hands comes off the market.
    function list(uint256 id, uint256 price) external {
        if (ownerOf(id) != msg.sender) revert NotCardOwner();
        priceOf[id] = price;
        emit Listed(id, msg.sender, price);
    }

    /// Buys a listed card at its asking price. The seller is paid at once, minus the market fee and the royalty,
    /// which go to the treasury and the royalty receiver.
    function buy(uint256 id) external payable nonReentrant {
        uint256 price = priceOf[id];
        if (price == 0 || msg.value != price) revert WrongPrice();
        address seller = ownerOf(id);
        if (seller == msg.sender) revert OwnCard();
        delete priceOf[id];
        _safeTransfer(seller, msg.sender, id);
        (address royaltyTo, uint256 royalty) = royaltyInfo(id, price);
        uint256 fee = (price * marketFeeBps) / 10_000;
        if (royaltyTo == treasury) {
            _send(treasury, fee + royalty);
        } else {
            _send(treasury, fee);
            _send(royaltyTo, royalty);
        }
        _send(seller, price - fee - royalty);
        emit Sold(id, seller, msg.sender, price);
    }

    // ------------------------------------------------------------------ Mythic cards

    /// Buys the next copy of a Mythic design at its fixed price; the payment goes straight to the treasury.
    function buyMythic(uint256 design) external payable nonReentrant returns (uint256 id) {
        Mythic storage m = _mythic(design);
        if (!m.open) revert SaleClosed();
        if (m.price == 0 || msg.value != m.price) revert WrongPrice();
        if (m.sold >= m.saleSupply) revert SoldOut();
        ++m.sold;
        id = _mintMythic(design, m, msg.sender, false);
        _pay();
    }

    /// Mints a free wheel prize from the design's reserve with the game server's voucher. Anyone may submit it (the
    /// card always goes to the winner it names), each voucher works once, and the reserve caps how many exist.
    function claimMythic(MythicClaim calldata v, bytes calldata sig) external nonReentrant returns (uint256 id) {
        _checkFresh(v.expiry);
        if (claimUsed[v.nonce]) revert ClaimUsed();
        if (ECDSA.recover(mythicClaimDigest(v), sig) != voucherSigner) revert BadSignature();
        Mythic storage m = _mythic(v.design);
        if (m.awarded >= m.wheelReserve) revert SoldOut();
        claimUsed[v.nonce] = true;
        ++m.awarded;
        id = _mintMythic(v.design, m, v.to, true);
    }

    // ------------------------------------------------------------------ views

    function card(uint256 id) external view returns (Card memory) {
        _requireOwned(id);
        return _cards[id];
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return renderer.tokenURI(id, _cards[id], _edition(id));
    }

    /// The series an Agent ID card belongs to: 1 is Genesis, 2 the next 10,000 cards, and so on; 0 for a Mythic id.
    function seriesOf(uint256 id) public pure returns (uint256) {
        if (id == 0 || id >= MYTHIC_BASE) return 0;
        return (id - 1) / GENESIS_SUPPLY + 1;
    }

    /// Whether card `id` is a Founder: true for card numbers 1 to 1,000, false for every later card and a Mythic id.
    function isFounder(uint256 id) public pure returns (bool) {
        return id != 0 && id <= FOUNDERS;
    }

    /// Every card in existence: Agent ID cards (totalSupply) plus all Mythic copies sold or awarded.
    function totalCards() public view returns (uint256 n) {
        n = totalSupply;
        for (uint256 d = 1; d <= mythicDesigns; ++d) {
            n += uint256(mythics[d].sold) + mythics[d].awarded;
        }
    }

    /// Where a card sits in its Mythic series (design, season, number, supply); all zero for other cards.
    function editionOf(uint256 id) external view returns (Edition memory) {
        _requireOwned(id);
        return _edition(id);
    }

    /// The highest level card `id` may show today: 10 on its mint day and 4 more for each day since, up to 50.
    function levelCap(uint256 id) external view returns (uint256) {
        _requireOwned(id);
        return _levelCap(_cards[id]);
    }

    /// The rarity a roll gives as card number `id`. The first 100 cards come out ~13/42/35/10 %
    /// Common/Rare/Epic/Legendary, ids up to 1,000 ~37/42/18/3, up to 5,000 ~55/35/8/2 and later 64/30/5/1.
    /// The roll is fixed per Agent ID, so it can't be re-rolled, and a roll is never worse for minting earlier.
    /// 30% of Epic and Legendary cards are also awakened.
    function rarityOf(uint32 roll, uint256 id) public pure returns (uint8 rarity, bool awakened) {
        uint256 r = roll % 10_000;
        uint256 rare;
        uint256 epic;
        uint256 legendary;
        if (id <= 100) (rare, epic, legendary) = (8_700, 4_500, 1_000);
        else if (id <= 1_000) (rare, epic, legendary) = (6_300, 2_100, 300);
        else if (id <= 5_000) (rare, epic, legendary) = (4_500, 1_000, 200);
        else (rare, epic, legendary) = (3_600, 600, 100);
        if (r < legendary) rarity = 3;
        else if (r < epic) rarity = 2;
        else if (r < rare) rarity = 1;
        awakened = rarity >= 2 && (roll / 10_000) % 100 < AWAKEN_PERCENT;
    }

    function statsDigest(Stats calldata s) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    STATS_TYPEHASH,
                    s.wallet,
                    keccak256(bytes(s.label)),
                    s.power,
                    s.defense,
                    s.speed,
                    s.luck,
                    s.role,
                    s.region,
                    s.badges,
                    s.roll,
                    s.issuedAt,
                    s.expiry
                )
            )
        );
    }

    function updateDigest(Update calldata u) public view returns (bytes32) {
        return
            _hashTypedDataV4(keccak256(abi.encode(UPDATE_TYPEHASH, u.id, u.level, u.badges, u.issuedAt, u.expiry)));
    }

    function mythicClaimDigest(MythicClaim calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(MYTHIC_CLAIM_TYPEHASH, v.to, v.design, v.nonce, v.expiry)));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------ owner

    /// Starts the 48-hour wait for a new treasury, signer, voucher signer, renderer or operator (addresses as
    /// uint256), market fee (bps), or fight pack or season pass price (wei, 0 = not for sale). A new proposal for the
    /// same setting replaces the old one and restarts the wait (a Mythic design's price: proposeMythicPrice).
    function propose(Setting setting, uint256 value) external onlyOwner {
        if (setting == Setting.MarketFee) {
            if (value > MAX_MARKET_FEE_BPS) revert FeeTooHigh();
        } else if (setting == Setting.MythicPrice) {
            revert BadSetting(); // it needs the design: proposeMythicPrice
        } else if (setting < Setting.FightPackPrice && (value == 0 || value > type(uint160).max)) {
            revert BadSetting(); // the address settings
        }
        _propose(setting, 0, value);
    }

    /// Starts the 48-hour wait for a new price of Mythic `design` (wei, 0 = not for sale), replacing one pending.
    function proposeMythicPrice(uint256 design, uint256 price) external onlyOwner {
        _mythic(design);
        _propose(Setting.MythicPrice, design, price);
    }

    function cancel(Setting setting) external onlyOwner {
        _drop(setting, 0);
    }

    function cancelMythicPrice(uint256 design) external onlyOwner {
        _drop(Setting.MythicPrice, design);
    }

    /// Applies a proposal once its 48 hours have passed (a Mythic design's price: executeMythicPrice).
    function execute(Setting setting) external onlyOwner {
        uint256 value = _take(setting, 0);
        address a = address(uint160(value));
        if (setting == Setting.Treasury) {
            treasury = payable(a);
            _setDefaultRoyalty(a, ROYALTY_BPS);
        } else if (setting == Setting.Signer) {
            signer = a;
        } else if (setting == Setting.VoucherSigner) {
            voucherSigner = a;
        } else if (setting == Setting.Renderer) {
            renderer = ICardRenderer(a);
        } else if (setting == Setting.Operator) {
            operator = a;
        } else if (setting == Setting.MarketFee) {
            marketFeeBps = uint16(value);
        } else if (setting == Setting.FightPackPrice) {
            fightPackPrice = value;
        } else if (setting == Setting.PassPrice) {
            passPrice = value;
        }
        emit SettingChanged(setting, 0, value);
    }

    /// Applies a proposed Mythic price once its 48 hours have passed; the sale stays open or closed as it was.
    function executeMythicPrice(uint256 design) external onlyOwner {
        uint256 price = _take(Setting.MythicPrice, design);
        mythics[design].price = price;
        emit SettingChanged(Setting.MythicPrice, design, price);
    }

    /// Removes the operator at once, no wait (say the agent wallet was tricked or its key leaked); a new operator
    /// takes the usual 48-hour proposal. A pending operator proposal goes too.
    function revokeOperator() external onlyOwner {
        operator = address(0);
        _drop(Setting.Operator, 0);
        emit SettingChanged(Setting.Operator, 0, 0);
    }

    /// Every pending proposal, for the site and ops tools to show (eta 0 = none): `settings` for each setting but
    /// MythicPrice, in Setting order, and `mythicPrices` for each Mythic design's price, design 1 first.
    function allPending() external view returns (Pending[] memory settings, Pending[] memory mythicPrices) {
        settings = new Pending[](uint256(Setting.MythicPrice));
        for (uint256 i; i < settings.length; ++i) settings[i] = pending[Setting(i)][0];
        mythicPrices = new Pending[](mythicDesigns);
        for (uint256 d; d < mythicPrices.length; ++d) mythicPrices[d] = pending[Setting.MythicPrice][d + 1];
    }

    /// Ownership only moves with transferOwnership + acceptOwnership; it can never be given up by mistake.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// Starts the 48-hour wait before `newOwner` may accept (address(0) cancels): the same delay as every setting that
    /// moves money or keys, so one tricked signature can't hand the contract over at once, and the owner sees
    /// OwnershipTransferStarted in time to cancel.
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

    /// A new owner starts clean: proposals queued under the previous owner are dropped, never inherited.
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        for (uint256 i; i < uint256(Setting.MythicPrice); ++i) _drop(Setting(i), 0);
        for (uint256 d = 1; d <= mythicDesigns; ++d) _drop(Setting.MythicPrice, d);
    }

    function _propose(Setting setting, uint256 design, uint256 value) private {
        uint64 eta = uint64(block.timestamp + TIMELOCK);
        pending[setting][design] = Pending(value, eta);
        emit SettingProposed(setting, design, value, eta);
    }

    /// Takes a proposal off the queue once its 48 hours have passed, and returns its value.
    function _take(Setting setting, uint256 design) private returns (uint256 value) {
        Pending memory p = pending[setting][design];
        if (p.eta == 0 || block.timestamp < p.eta) revert NotReady();
        delete pending[setting][design];
        value = p.value;
    }

    function _drop(Setting setting, uint256 design) private {
        if (pending[setting][design].eta == 0) return;
        delete pending[setting][design];
        emit SettingCancelled(setting, design);
    }

    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
        emit ConfigSet("mintOpen", open ? 1 : 0, 0);
    }

    /// Reopens (or closes) signed level updates, say once a leaked signer has been replaced.
    function setUpdatesOpen(bool open) external onlyOwner {
        updatesOpen = open;
        emit ConfigSet("updatesOpen", open ? 1 : 0, 0);
    }

    /// The fight pack's launch price (0 = not for sale), applied at once while no card exists. From the first card on
    /// a price changes only through propose(Setting.FightPackPrice, price) and its 48-hour wait, lower or higher alike.
    function setFightPackPrice(uint256 price) external onlyOwner {
        _beforeFirstCard();
        fightPackPrice = price;
        emit ConfigSet("fightPackPrice", price, 0);
    }

    /// The season pass's launch price, on the same terms: later changes go through propose(Setting.PassPrice, price).
    function setPassPrice(uint256 price) external onlyOwner {
        _beforeFirstCard();
        passPrice = price;
        emit ConfigSet("passPrice", price, 0);
    }

    /// Opens (or closes) regions for minting: bit 0 West, 1 East, 2 North, 3 South.
    function setOpenRegions(uint16 mask) external onlyOwner {
        openRegions = mask;
        emit ConfigSet("openRegions", mask, 0);
    }

    // ---- upkeep: the owner or the operator. None of it moves money or changes a price, key or ownership.

    /// The emergency brake: stops new mints at once. Only the owner opens minting again (setMintOpen).
    function pauseMint() external onlyOperator {
        mintOpen = false;
        emit ConfigSet("mintOpen", 0, 0);
    }

    /// The same brake for signed level updates (a leaked signer signs levels too). Only the owner reopens them.
    function pauseUpdates() external onlyOperator {
        updatesOpen = false;
        emit ConfigSet("updatesOpen", 0, 0);
    }

    /// Free holo for promotions (pre-launch X tasks, referral rewards) and wheel prizes. Cards already holo are skipped.
    function grantHolo(uint256[] calldata ids) external onlyOperator {
        for (uint256 i; i < ids.length; ++i) {
            _requireOwned(ids[i]);
            Card storage c = _cards[ids[i]];
            if (c.holo) continue;
            c.holo = true;
            emit HoloApplied(ids[i], msg.sender);
        }
    }

    /// Free frames for wheel prizes and promotions. A card that already wears a frame keeps it.
    function grantFrame(uint256[] calldata ids, uint16 frame) external onlyOperator {
        if (frame == 0) revert BadFrame();
        for (uint256 i; i < ids.length; ++i) {
            _requireOwned(ids[i]);
            Card storage c = _cards[ids[i]];
            if (c.frame != 0) continue;
            c.frame = frame;
            emit FrameApplied(ids[i], frame);
        }
    }

    /// Shrinks a design's sale supply and wheel reserve, never below the copies already out. Neither can grow.
    function capMythic(uint256 design, uint16 saleSupply, uint16 wheelReserve) external onlyOperator {
        Mythic storage m = _mythic(design);
        if (saleSupply > m.saleSupply || saleSupply < m.sold || wheelReserve > m.wheelReserve || wheelReserve < m.awarded) {
            revert BadSupply();
        }
        m.saleSupply = saleSupply;
        m.wheelReserve = wheelReserve;
        emit MythicCapped(design, saleSupply, wheelReserve);
    }

    // ---- owner only again: Mythic designs and their sale.

    /// Adds a Mythic design at its price, open for sale or not. Every copy gets the design's name, realm, role and
    /// stats. A design added once cards exist comes with its price too; changing it later waits like any price.
    function addMythic(Mythic calldata m) external onlyOwner returns (uint256 design) {
        design = _addMythic(m);
    }

    /// A season's designs in one transaction, so the owner signs once.
    function addMythics(Mythic[] calldata ms) external onlyOwner {
        for (uint256 i; i < ms.length; ++i) _addMythic(ms[i]);
    }

    function _addMythic(Mythic calldata m) private returns (uint256 design) {
        _checkMythicName(m.name);
        _checkStats(m.power, m.defense, m.speed, m.luck);
        if (m.role == 0 || m.role > MINT_ROLES || m.region > MAX_REGION) revert BadStats();
        uint256 supply = uint256(m.saleSupply) + m.wheelReserve;
        if (m.sold != 0 || m.awarded != 0 || supply == 0 || supply > MAX_COPIES) revert BadSupply();
        design = ++mythicDesigns;
        mythics[design] = m;
        emit MythicAdded(design, m.name, uint16(supply), m.price);
    }

    /// Opens or closes a design's sale at once (the wheel reserve doesn't depend on it). Its price changes here only
    /// while no card exists; from the first card on, pass the current price and propose a new one with
    /// proposeMythicPrice, which waits 48 hours like every price.
    function setMythicSale(uint256 design, uint256 price, bool open) external onlyOwner {
        Mythic storage m = _mythic(design);
        if (price != m.price) _beforeFirstCard();
        m.price = price;
        m.open = open;
        emit MythicSaleSet(design, price, open);
    }

    // ------------------------------------------------------------------ internal

    function _checkFresh(uint64 expiry) private view {
        if (block.timestamp > expiry) revert Expired();
    }

    /// Prices apply at once only while no card exists, neither an Agent ID card nor a Mythic copy: the owner's launch
    /// settings. Cards are never burned, so from the first card on this always reverts and a price can only change
    /// through a proposal that waits 48 hours.
    function _beforeFirstCard() private view {
        if (totalCards() != 0) revert Timelocked();
    }

    /// Each stat 1..99, and together no more than a minted card can reach (MAX_STAT_TOTAL).
    function _checkStats(uint8 power, uint8 defense, uint8 speed, uint8 luck) private pure {
        if (
            power == 0 || power > 99 || defense == 0 || defense > 99 || speed == 0 || speed > 99 || luck == 0
                || luck > 99 || uint256(power) + defense + speed + luck > MAX_STAT_TOTAL
        ) revert BadStats();
    }

    /// Agent ID labels as the registry stores them: lowercase letters, digits, "_" and "-".
    /// Anything else could break the metadata JSON, and the hash check would fail on it anyway.
    function _checkLabel(string calldata label) private pure {
        bytes calldata b = bytes(label);
        if (b.length == 0 || b.length > MAX_LABEL) revert BadName();
        for (uint256 i; i < b.length; ++i) {
            bytes1 ch = b[i];
            bool ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch == "_" || ch == "-";
            if (!ok) revert BadName();
        }
    }

    function _holdsAgentId(uint256 agentId) private view returns (bool) {
        try agentRegistry.ownerOf(agentId) returns (address holder) {
            return holder == msg.sender;
        } catch {
            return false; // unregistered names revert
        }
    }

    function _levelCap(Card storage c) private view returns (uint256) {
        uint256 byAge = START_LEVEL_CAP + LEVELS_PER_DAY * ((block.timestamp - c.mintedAt) / 1 days);
        return byAge < MAX_LEVEL ? byAge : MAX_LEVEL;
    }

    /// Design names show in metadata: letters, digits, spaces, "-" and "'" only, so they can't break the JSON.
    function _checkMythicName(string calldata name) private pure {
        bytes calldata b = bytes(name);
        if (b.length == 0 || b.length > MAX_MYTHIC_NAME) revert BadName();
        for (uint256 i; i < b.length; ++i) {
            bytes1 ch = b[i];
            bool ok = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch == " "
                || ch == "-" || ch == "'";
            if (!ok) revert BadName();
        }
    }

    function _mythic(uint256 design) private view returns (Mythic storage m) {
        if (design == 0 || design > mythicDesigns) revert NoSuchDesign();
        m = mythics[design];
    }

    /// Mints the copy just counted in `m` (sold or awarded) to `to`, numbered in the order copies go out.
    function _mintMythic(uint256 design, Mythic storage m, address to, bool wheel) private returns (uint256 id) {
        uint16 number = m.sold + m.awarded;
        id = MYTHIC_BASE + design * 1_000 + number;
        Card storage c = _cards[id];
        c.name = m.name;
        c.agent = to;
        c.power = m.power;
        c.defense = m.defense;
        c.speed = m.speed;
        c.luck = m.luck;
        c.role = m.role;
        c.region = m.region;
        c.rarity = MYTHIC;
        c.level = 1;
        c.mintedAt = uint64(block.timestamp);
        c.updatedAt = uint64(block.timestamp);
        _safeMint(to, id);
        emit MythicMinted(id, design, to, number, wheel);
    }

    function _edition(uint256 id) private view returns (Edition memory e) {
        if (id <= MYTHIC_BASE) return e;
        uint256 design = (id - MYTHIC_BASE) / 1_000;
        Mythic storage m = mythics[design];
        e = Edition(uint16(design), m.season, uint16(id % 1_000), m.saleSupply + m.wheelReserve);
    }

    /// A card that changes hands (sale, gift, market) comes off the market.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (priceOf[tokenId] != 0) delete priceOf[tokenId];
    }

    function _pay() private {
        _send(treasury, msg.value);
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert PaymentFailed();
    }
}
