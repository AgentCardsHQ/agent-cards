// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// Stand-in for the SPACE ID Agent ID registry in tests: anyone can register a name, and like the real
/// registry the token id is the label's hash.
contract MockRegistry is ERC721 {
    constructor() ERC721("Mock Agent ID", "AI") {}

    function register(address to, string calldata label) external {
        _mint(to, uint256(keccak256(bytes(label))));
    }
}

/// A treasury that refuses payments, to prove failed forwarding reverts.
contract RejectingTreasury {
    receive() external payable {
        revert("no");
    }
}
