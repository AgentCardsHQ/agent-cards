// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IRewardPool {
    function claim(uint256 season, uint256 amount, bytes32[] calldata proof) external;
}

/// A claimant contract for the RewardPool tests: it tries to claim again from inside the payment (reentrancy), or
/// refuses the payment outright.
contract PoolClaimer {
    IRewardPool public immutable pool;
    uint256 private season;
    uint256 private amount;
    bytes32[] private proof;
    bool public refuse;
    bool public reentered; // whether a claim from inside the payment got through

    constructor(IRewardPool pool_) {
        pool = pool_;
    }

    function setRefuse(bool refuse_) external {
        refuse = refuse_;
    }

    function claim(uint256 season_, uint256 amount_, bytes32[] calldata proof_) external {
        (season, amount, proof) = (season_, amount_, proof_);
        pool.claim(season_, amount_, proof_);
    }

    receive() external payable {
        if (refuse) revert("no");
        try pool.claim(season, amount, proof) {
            reentered = true;
        } catch {}
    }
}
