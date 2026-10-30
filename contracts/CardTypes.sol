// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// A card's stored state. Stats run 1..99; role and rarity index the renderer's tables.
struct Card {
    string name; // Agent ID name, e.g. "nova.ai" (validated on mint: a-z 0-9 _ - plus ".ai"); a Mythic's own name
    address agent; // the Agent ID wallet that minted it (the card itself may change hands); a Mythic's first holder
    uint8 power;
    uint8 defense;
    uint8 speed;
    uint8 luck;
    uint8 role; // 1 Warrior, 2 Priest, 3 Mage, 4 Assassin; fixed at mint
    uint8 region; // 0 West, 1 East, 2 North, 3 South; fixed at mint
    bool awakened; // rolled at mint for Epic and Legendary cards: unlocks the region's hidden class
    uint8 rarity; // 0 Common, 1 Rare, 2 Epic, 3 Legendary (rolled at mint); 4 Mythic (a limited series)
    uint32 badges; // cosmetic: projects the agent took part in
    bool holo;
    uint16 frame; // 0 = none
    uint16 level; // game progress; only ever goes up, and moves with the token when sold
    uint64 mintedAt;
    uint64 updatedAt;
}

/// A Mythic card's place in its limited series; all zero for every other card.
struct Edition {
    uint16 design; // the Mythic design, from 1
    uint8 season; // the season the design came out in
    uint16 number; // this card's number in the series, from 1
    uint16 supply; // how many copies the series can ever have
}

interface ICardRenderer {
    function tokenURI(uint256 id, Card calldata card, Edition calldata edition) external view returns (string memory);
}
