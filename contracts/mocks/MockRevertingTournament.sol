// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ITournament} from "../interfaces/ITournament.sol";

/// @title MockRevertingTournament
/// @notice TESTS / LOCAL ONLY. Tournament whose {recordScore} always reverts (or burns all gas), to prove the game's
///         randomness callback survives a broken tournament.
contract MockRevertingTournament is ITournament {
    /// @notice When true, {recordScore} loops until it runs out of gas instead of reverting.
    bool public burnAllGas;

    error Broken();

    /// @notice Switches between a plain revert and gas exhaustion.
    function setBurnAllGas(bool value) external {
        burnAllGas = value;
    }

    /// @inheritdoc ITournament
    function recordScore(address, uint256) external view {
        if (burnAllGas) {
            while (true) {}
        }
        revert Broken();
    }

    /// @inheritdoc ITournament
    function notifyReward(uint256) external pure {
        revert Broken();
    }

    /// @inheritdoc ITournament
    function currentSeason() external pure returns (uint256) {
        return 0;
    }
}
