// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {StakedDuels} from "../StakedDuels.sol";

/// Test only: StakedDuels with its block-hash reads opened up, so they can be checked against a chain's own history
/// (test/staked-duels-fork.test.js reads BSC mainnet's real EIP-2935 contract through it).
contract StakedDuelsProbe is StakedDuels {
    constructor(IERC721 cards_) StakedDuels(msg.sender, cards_, payable(msg.sender), msg.sender, 1, 1, 1, 1) {}

    function seedAt(uint64 lockBlock) external view returns (bytes32) {
        return _seedOrZero(lockBlock);
    }

    function historyAt(uint256 n) external view returns (bytes32) {
        return _history(n);
    }

    function blockNumber() external view returns (uint256) {
        return block.number;
    }
}

/// Test only: a wallet contract that tries to withdraw again from inside its own receive(), to prove the
/// reentrancy guard holds on the one function that pushes BNB to an arbitrary address.
contract HostileWithdrawer {
    StakedDuels public duels;
    bool public reenter;

    function arm(StakedDuels duels_) external {
        duels = duels_;
        reenter = true;
    }

    function deposit() external payable {
        duels.deposit{value: msg.value}();
    }

    function withdraw(uint256 amount) external {
        duels.withdraw(amount);
    }

    receive() external payable {
        if (reenter) {
            reenter = false;
            duels.withdraw(1);
        }
    }
}
