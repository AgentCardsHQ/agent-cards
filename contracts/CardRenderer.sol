// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Card, Edition, ICardRenderer} from "./CardTypes.sol";

/// @title Agent Cards renderer
/// @notice Builds each card's metadata on chain (name, role, rarity, stats, badges) and points the image
/// at the art server, which composes the illustrated card. Kept apart from the token so the art host
/// can move (for example to IPFS) without a redeploy. The links every marketplace shows can only change 48 hours
/// after they are proposed, like the token's own critical settings, so a tricked owner key can't swap in a
/// phishing site unnoticed.
contract CardRenderer is ICardRenderer, Ownable2Step {
    using Strings for uint256;

    uint256 public constant TIMELOCK = 48 hours;
    /// AgentCards.seriesOf's rule: the first 10,000 Agent ID cards are Genesis, each further 10,000 the next series.
    uint256 private constant GENESIS_SUPPLY = 10_000;
    uint256 private constant MAX_LINK = 200;

    struct Links {
        string imageBase;
        string imageSuffix;
        string siteBase;
        string animationBase;
        string animationSuffix;
    }

    Links private _proposed;
    uint64 public linksEta; // when the proposed links may be applied; 0 = none pending
    uint64 public ownerEta; // when a started ownership transfer may be accepted; 0 = none started

    event LinksProposed(Links links, uint64 eta);
    event LinksCancelled();
    event OwnershipProposed(address indexed newOwner, uint64 eta);
    event LinksChanged(Links links);

    error NotReady();
    error RenounceDisabled();
    error BadLink();

    string private constant DESCRIPTION =
        "Agent Cards: a free trading card for every Binance Agent ID agent. The card is the agent's game character.";
    string private constant MYTHIC_DESCRIPTION =
        "Agent Cards Mythic: one copy of a limited, numbered series. It plays at Legendary strength, with its own art and title.";

    string public imageBase; // e.g. "https://agentcards.example/api/card/"; the image is <base><id><suffix>
    string public imageSuffix; // e.g. ".svg"
    string public siteBase; // e.g. "https://agentcards.example/card/"; the card's page is <base><id>
    // Mythic cards can move: their animation_url is <animationBase><id><animationSuffix>, left out while the base is empty
    string public animationBase;
    string public animationSuffix;

    /// Mythic cards (e.number > 0) get their own name, a Mythic description, Series and Edition traits and, while the
    /// animation base is set, an animation_url. All links are set here at deploy and change only through proposeLinks.
    constructor(address owner_, Links memory links) Ownable(owner_) {
        _checkLinks(links);
        _apply(links);
    }

    function proposedLinks() external view returns (Links memory) {
        return _proposed;
    }

    /// Starts the 48-hour wait for new links; a new proposal replaces the old one and restarts the wait.
    function proposeLinks(Links calldata links) external onlyOwner {
        _checkLinks(links);
        _proposed = links;
        linksEta = uint64(block.timestamp + TIMELOCK);
        emit LinksProposed(links, linksEta);
    }

    function cancelLinks() external onlyOwner {
        delete _proposed;
        linksEta = 0;
        emit LinksCancelled();
    }

    function executeLinks() external onlyOwner {
        if (linksEta == 0 || block.timestamp < linksEta) revert NotReady();
        Links memory links = _proposed;
        delete _proposed;
        linksEta = 0;
        _apply(links);
        emit LinksChanged(links);
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

    /// A new owner starts clean: links proposed under the previous owner are dropped, never inherited.
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        if (linksEta != 0) {
            delete _proposed;
            linksEta = 0;
            emit LinksCancelled();
        }
    }

    /// Links go into the metadata JSON as they are, so they must not be able to break out of a string: printable
    /// ASCII only, no space, quote or backslash, and at most MAX_LINK bytes each. Empty is fine (no animation).
    function _checkLinks(Links memory links) private pure {
        _checkLink(links.imageBase);
        _checkLink(links.imageSuffix);
        _checkLink(links.siteBase);
        _checkLink(links.animationBase);
        _checkLink(links.animationSuffix);
    }

    function _checkLink(string memory link) private pure {
        bytes memory b = bytes(link);
        if (b.length > MAX_LINK) revert BadLink();
        for (uint256 i; i < b.length; ++i) {
            uint8 ch = uint8(b[i]);
            if (ch <= 0x20 || ch >= 0x7f || ch == 0x22 || ch == 0x5c) revert BadLink();
        }
    }

    function _apply(Links memory links) private {
        imageBase = links.imageBase;
        imageSuffix = links.imageSuffix;
        siteBase = links.siteBase;
        animationBase = links.animationBase;
        animationSuffix = links.animationSuffix;
    }

    function tokenURI(uint256 id, Card calldata c, Edition calldata e) external view returns (string memory) {
        bool mythic = e.number != 0;
        string memory json = string.concat(
            '{"name":"',
            c.name,
            mythic
                ? string.concat(" #", uint256(e.number).toString(), "/", uint256(e.supply).toString())
                : string.concat(" #", id.toString()),
            '","description":"',
            mythic ? MYTHIC_DESCRIPTION : DESCRIPTION,
            '","image":"',
            imageBase,
            id.toString(),
            imageSuffix,
            "?v=",
            uint256(c.updatedAt).toString(), // a new URL after every update so marketplaces refetch the art
            '","external_url":"',
            siteBase,
            id.toString(),
            '"',
            mythic && bytes(animationBase).length != 0
                ? string.concat(',"animation_url":"', animationBase, id.toString(), animationSuffix, '"')
                : "",
            ',"attributes":',
            _attributes(id, c, e),
            "}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _attributes(uint256 id, Card calldata c, Edition calldata e) private pure returns (string memory) {
        string memory a = string.concat(
            '[{"trait_type":"Class","value":"',
            e.number != 0 ? c.name : className(c.region, c.role, c.awakened),
            '"},{"trait_type":"Region","value":"',
            regionName(c.region),
            '"},{"trait_type":"Role","value":"',
            roleName(c.role),
            '"},{"trait_type":"Awakened","value":"',
            c.awakened ? "Yes" : "No",
            '"},{"trait_type":"Rarity","value":"',
            rarityName(c.rarity),
            '"},',
            _num("Level", c.level),
            _num("Power", c.power),
            _num("Defense", c.defense),
            _num("Speed", c.speed),
            _num("Luck", c.luck),
            '{"trait_type":"Holo","value":"',
            c.holo ? "Yes" : "No",
            '"},{"trait_type":"Frame","value":"',
            _frameName(c.frame),
            '"}'
        );
        if (e.number == 0) {
            // an Agent ID card: Genesis for card numbers 1 to 10,000, then Series 2, 3, ...
            uint256 series = (id - 1) / GENESIS_SUPPLY + 1;
            a = string.concat(a, ',{"trait_type":"Series","value":"', series == 1 ? "Genesis" : string.concat("Series ", series.toString()), '"}');
        } else {
            a = string.concat(
                a,
                ',{"trait_type":"Series","value":"Season ',
                uint256(e.season).toString(),
                '"},{"trait_type":"Edition","value":"',
                uint256(e.number).toString(),
                " of ",
                uint256(e.supply).toString(),
                '"}'
            );
        }
        for (uint256 i; i < 8; ++i) {
            if ((c.badges >> i) & 1 != 0) a = string.concat(a, ',{"trait_type":"Badge","value":"', _badgeName(i), '"}');
        }
        return string.concat(a, "]");
    }

    function _num(string memory trait, uint256 v) private pure returns (string memory) {
        return string.concat('{"trait_type":"', trait, '","display_type":"number","value":', v.toString(), "},");
    }

    // ------------------------------------------------------------------ tables

    function roleName(uint8 role) public pure returns (string memory) {
        if (role == 1) return "Warrior";
        if (role == 2) return "Priest";
        if (role == 3) return "Mage";
        if (role == 4) return "Assassin";
        return string.concat("Role ", uint256(role).toString()); // later seasons ship a renderer that names them
    }

    function regionName(uint8 region) public pure returns (string memory) {
        if (region == 0) return "West";
        if (region == 1) return "East";
        if (region == 2) return "North";
        if (region == 3) return "South";
        return string.concat("Region ", uint256(region).toString());
    }

    /// Each region names its four roles; awakened cards of a role with a hidden class get that class.
    function className(uint8 region, uint8 role, bool awakened) public pure returns (string memory) {
        if (region == 1 && role == 4 && awakened) return "Blind Sword Master";
        string[4] memory names;
        if (region == 0) names = ["Paladin", "Templar", "Archmage", "Shadow Blade"];
        else if (region == 1) names = ["Iron Mountain Monk", "Wandering Daoist", "Talisman Sage", "Plum Blossom Swordsman"];
        else if (region == 2) names = ["Berserker", "Rune Priestess", "Frost Witch", "Wolf Hunter"];
        else if (region == 3) names = ["Sun Guardian", "Oracle", "Djinn Caller", "Sand Dancer"];
        else return string.concat(regionName(region), " ", roleName(role));
        return role >= 1 && role <= 4 ? names[role - 1] : string.concat(regionName(region), " ", roleName(role));
    }

    function rarityName(uint8 r) public pure returns (string memory) {
        if (r == 4) return "Mythic";
        if (r == 3) return "Legendary";
        if (r == 2) return "Epic";
        if (r == 1) return "Rare";
        return "Common";
    }

    function _frameName(uint16 f) private pure returns (string memory) {
        if (f == 1) return "Gold";
        if (f == 2) return "Neon";
        if (f == 3) return "Vine";
        return "None";
    }

    function _badgeName(uint256 i) private pure returns (string memory) {
        if (i == 0) return "RUNES";
        if (i == 1) return "COLO";
        if (i == 2) return "TOSH";
        if (i == 3) return "HASHORE";
        if (i == 4) return "TINYFARM";
        if (i == 5) return "CROLL";
        if (i == 6) return "PTAH";
        return "AIDROP";
    }
}
