// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRevenueRouter
/// @notice Splits $GAME revenue (rod purchases, repairs) between prize pools, burn, tournament and treasury.
interface IRevenueRouter {
    /// @notice Splits `amount` of $GAME that the caller has already transferred to the router.
    /// @param amount Amount of $GAME received for this payment.
    function distribute(uint256 amount) external;
}
