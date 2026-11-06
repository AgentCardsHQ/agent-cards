// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {CardEvolution} from "../CardEvolution.sol";

/// Test only: plain cards anyone can mint.
contract MockCards is ERC721("Mock Cards", "MC") {
    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// Test only: a treasury that refuses money, or tries to evolve again while it is being paid.
contract HostileTreasury {
    CardEvolution public evolution;
    CardEvolution.Voucher private voucher;
    bytes private sig;
    bool public reenter;

    function arm(CardEvolution evolution_, CardEvolution.Voucher calldata v, bytes calldata sig_) external {
        evolution = evolution_;
        voucher = v;
        sig = sig_;
        reenter = true;
    }

    receive() external payable {
        if (!reenter) revert("no money");
        evolution.evolve{value: msg.value}(voucher, sig);
    }
}
