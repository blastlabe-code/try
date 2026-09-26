// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ITournament} from "./interfaces/ITournament.sol";

/// @title Tournament
/// @notice Weekly seasons with a sorted on-chain top-10 leaderboard and $GAME prizes.
/// @dev Season `s` covers `[genesis + s * seasonLength, genesis + (s + 1) * seasonLength)`. The FishingGame
///      records catch scores (`GAME_ROLE`); the RevenueRouter (or anyone) funds the current season with
///      {notifyReward}. After a season ends anyone can {finalize} it: ranks 1..10 receive
///      `[3000, 2000, 1300, 1000, 800, 600, 500, 400, 200, 200]` bps of its prize pool, and whatever is not
///      awarded (unfilled ranks + rounding dust) rolls over to the next unfinalized season.
contract Tournament is AccessControl, ReentrancyGuardTransient, ITournament {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to record scores (the FishingGame).
    bytes32 public constant GAME_ROLE = keccak256("GAME_ROLE");
    /// @notice Leaderboard size.
    uint256 public constant TOP_SIZE = 10;
    /// @notice Basis-point denominator.
    uint256 public constant BPS = 10_000;

    /// @dev Payout bps for ranks 1..10, 16 bits per rank (rank 1 in the lowest bits). Sums to 10_000.
    uint256 private constant PAYOUT_BPS_PACKED = 3000 | (2000 << 16) | (1300 << 32) | (1000 << 48) | (800 << 64)
        | (600 << 80) | (500 << 96) | (400 << 112) | (200 << 128) | (200 << 144);

    uint256 private constant MIN_SEASON_LENGTH = 1 hours;
    uint256 private constant MAX_SEASON_LENGTH = 90 days;

    /// @notice Per-season state.
    /// @param prizePool $GAME allocated to the season (rewards notified during it + rollovers).
    /// @param finalized Whether prizes were assigned.
    /// @param entrants Number of filled leaderboard slots (<= 10).
    /// @param top Leaderboard, best first.
    struct Season {
        uint256 prizePool;
        bool finalized;
        uint8 entrants;
        address[10] top;
    }

    /// @notice Prize token ($GAME).
    IERC20 public immutable gameToken;
    /// @notice Start of season 0.
    uint256 public immutable genesis;
    /// @notice Length of every season in seconds.
    uint256 public immutable seasonLength;

    mapping(uint256 season => Season) private _seasons;
    mapping(uint256 season => mapping(address player => uint256)) private _scores;
    mapping(uint256 season => mapping(address player => uint256)) private _awards;

    event ScoreRecorded(uint256 indexed season, address indexed player, uint256 points, uint256 totalScore);
    event RewardNotified(uint256 indexed season, address indexed from, uint256 amount);
    event PrizeAwarded(uint256 indexed season, address indexed player, uint256 rank, uint256 amount);
    event SeasonFinalized(
        uint256 indexed season, uint256 prizePool, uint256 awarded, uint256 rolledOver, uint256 rolloverSeason
    );
    event PrizeClaimed(uint256 indexed season, address indexed player, uint256 amount);

    error ZeroAddress();
    error InvalidSeasonConfig();
    error SeasonNotEnded(uint256 season);
    error SeasonAlreadyFinalized(uint256 season);
    error NothingToClaim(uint256 season);

    /// @param admin Receives `DEFAULT_ADMIN_ROLE`.
    /// @param gameToken_ The $GAME token.
    /// @param genesis_ Start of season 0 (0 = deployment time); must not be in the future.
    /// @param seasonLength_ Season length in seconds (1 hour .. 90 days; SPEC default 7 days).
    constructor(address admin, IERC20 gameToken_, uint256 genesis_, uint256 seasonLength_) {
        if (admin == address(0) || address(gameToken_) == address(0)) revert ZeroAddress();
        if (genesis_ == 0) genesis_ = block.timestamp;
        if (genesis_ > block.timestamp || seasonLength_ < MIN_SEASON_LENGTH || seasonLength_ > MAX_SEASON_LENGTH) {
            revert InvalidSeasonConfig();
        }
        gameToken = gameToken_;
        genesis = genesis_;
        seasonLength = seasonLength_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Scoring & funding
    // ------------------------------------------------------------------------------------------------------------

    /// @inheritdoc ITournament
    /// @dev O(10) leaderboard maintenance. A player only moves above another with a strictly higher score, and only
    ///      enters a full board by strictly beating the 10th place, so ties keep the player who got there first.
    function recordScore(address player, uint256 points) external onlyRole(GAME_ROLE) {
        if (points == 0 || player == address(0)) return;
        uint256 season = currentSeason();
        uint256 total = _scores[season][player] + points;
        _scores[season][player] = total;
        _updateLeaderboard(season, player, total);
        emit ScoreRecorded(season, player, points, total);
    }

    /// @inheritdoc ITournament
    function notifyReward(uint256 amount) external nonReentrant {
        if (amount == 0) return;
        uint256 season = currentSeason();
        gameToken.safeTransferFrom(msg.sender, address(this), amount);
        _seasons[season].prizePool += amount;
        emit RewardNotified(season, msg.sender, amount);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Settlement
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Assigns the prizes of an ended season; callable by anyone.
    /// @param season Season to finalize (must have ended and not be finalized yet).
    function finalize(uint256 season) external {
        if (season >= currentSeason()) revert SeasonNotEnded(season);
        Season storage s = _seasons[season];
        if (s.finalized) revert SeasonAlreadyFinalized(season);
        s.finalized = true;

        uint256 prize = s.prizePool;
        uint256 awarded;
        uint256 entrants = s.entrants;
        for (uint256 rank; rank < entrants; ++rank) {
            address player = s.top[rank];
            uint256 amount = (prize * payoutBps(rank)) / BPS;
            _awards[season][player] = amount;
            awarded += amount;
            emit PrizeAwarded(season, player, rank + 1, amount);
        }

        uint256 rollover = prize - awarded;
        uint256 target = season + 1;
        while (_seasons[target].finalized) ++target;
        if (rollover != 0) _seasons[target].prizePool += rollover;
        emit SeasonFinalized(season, prize, awarded, rollover, target);
    }

    /// @notice Withdraws the caller's prize for a finalized season.
    function claim(uint256 season) external nonReentrant {
        uint256 amount = _awards[season][msg.sender];
        if (amount == 0) revert NothingToClaim(season);
        _awards[season][msg.sender] = 0;
        gameToken.safeTransfer(msg.sender, amount);
        emit PrizeClaimed(season, msg.sender, amount);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    /// @inheritdoc ITournament
    function currentSeason() public view returns (uint256) {
        return (block.timestamp - genesis) / seasonLength;
    }

    /// @notice Payout share of a 0-based leaderboard rank, in bps.
    function payoutBps(uint256 rank) public pure returns (uint256) {
        if (rank >= TOP_SIZE) return 0;
        return (PAYOUT_BPS_PACKED >> (16 * rank)) & 0xFFFF;
    }

    /// @notice Timing and prize state of a season.
    function seasonInfo(uint256 season)
        external
        view
        returns (uint256 start, uint256 end, uint256 prizePool, bool finalized, uint256 entrants)
    {
        Season storage s = _seasons[season];
        start = genesis + season * seasonLength;
        end = start + seasonLength;
        return (start, end, s.prizePool, s.finalized, s.entrants);
    }

    /// @notice Leaderboard of a season, best first (only filled slots).
    function getLeaderboard(uint256 season) public view returns (address[] memory players, uint256[] memory scores) {
        Season storage s = _seasons[season];
        uint256 n = s.entrants;
        players = new address[](n);
        scores = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            address player = s.top[i];
            players[i] = player;
            scores[i] = _scores[season][player];
        }
    }

    /// @notice Current season index, end time and leaderboard in one call.
    function currentLeaderboard()
        external
        view
        returns (uint256 season, uint256 endsAt, uint256 prizePool, address[] memory players, uint256[] memory scores)
    {
        season = currentSeason();
        endsAt = genesis + (season + 1) * seasonLength;
        prizePool = _seasons[season].prizePool;
        (players, scores) = getLeaderboard(season);
    }

    /// @notice Score of `player` in `season`.
    function scoreOf(uint256 season, address player) external view returns (uint256) {
        return _scores[season][player];
    }

    /// @notice Unclaimed prize of `player` for a finalized `season`.
    function awardOf(uint256 season, address player) external view returns (uint256) {
        return _awards[season][player];
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------------------------

    function _updateLeaderboard(uint256 season, address player, uint256 total) private {
        Season storage s = _seasons[season];
        uint256 n = s.entrants;
        uint256 pos = n;
        for (uint256 i; i < n; ++i) {
            if (s.top[i] == player) {
                pos = i;
                break;
            }
        }
        if (pos == n) {
            if (n < TOP_SIZE) {
                s.entrants = uint8(n + 1);
            } else {
                if (total <= _scores[season][s.top[TOP_SIZE - 1]]) return;
                pos = TOP_SIZE - 1;
            }
        }
        // Shift strictly lower scores down one slot, then drop the player into the gap.
        while (pos > 0) {
            address above = s.top[pos - 1];
            if (_scores[season][above] >= total) break;
            s.top[pos] = above;
            --pos;
        }
        s.top[pos] = player;
    }
}
