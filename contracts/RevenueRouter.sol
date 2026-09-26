// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IRevenueRouter} from "./interfaces/IRevenueRouter.sol";
import {IPrizeVault} from "./interfaces/IPrizeVault.sol";
import {ITournament} from "./interfaces/ITournament.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title RevenueRouter
/// @notice Splits every $GAME payment (rod purchase, repair) immediately into five buckets and recycles the stock
///         bucket into stock tokens for the PrizeVault.
/// @dev Buckets (bps, default): stock budget 3000 (kept here until a keeper {recycle}s it), prize vault 3500
///      ($GAME pool), burn 1500, tournament 1000, treasury 1000. The prize-vault bucket also receives the integer
///      rounding dust (`amount - other buckets`). If no tournament is set, its bucket goes to the prize vault.
///      On-chain bounds: sum = 10_000, stock >= 2000, burn + treasury <= 3500, treasury <= 2000.
contract RevenueRouter is AccessControl, ReentrancyGuardTransient, IRevenueRouter {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to report revenue (the FishingGame).
    bytes32 public constant GAME_ROLE = keccak256("GAME_ROLE");
    /// @notice Role allowed to change the split and recycling limits.
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    /// @notice Role allowed to run {recycle}.
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    /// @notice Basis-point denominator.
    uint256 public constant BPS = 10_000;
    /// @notice Burn sink used when $GAME does not implement `ERC20Burnable.burn`.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 private constant MIN_STOCK_BPS = 2000;
    uint256 private constant MAX_BURN_PLUS_TREASURY_BPS = 3500;
    uint256 private constant MAX_TREASURY_BPS = 2000;
    uint256 private constant MAX_RECYCLE_INTERVAL = 7 days;

    /// @notice Revenue split in basis points.
    struct Split {
        uint16 stockBps;
        uint16 vaultBps;
        uint16 burnBps;
        uint16 tournamentBps;
        uint16 treasuryBps;
    }

    /// @notice The $GAME token.
    IERC20 public immutable gameToken;
    /// @notice Prize vault receiving the $GAME bucket and recycled stock tokens.
    IPrizeVault public immutable prizeVault;

    /// @notice Tournament receiving its bucket (zero = disabled, bucket goes to the prize vault).
    ITournament public tournament;
    /// @notice Treasury receiving its bucket.
    address public treasury;
    /// @notice Venue used by {recycle}.
    ISwapAdapter public swapAdapter;

    Split private _split;

    /// @notice $GAME earmarked for recycling into stock tokens.
    uint256 public stockBudget;
    /// @notice Lifetime $GAME revenue distributed.
    uint128 public totalRevenue;
    /// @notice Lifetime $GAME burned (or sent to {DEAD}).
    uint128 public totalBurned;

    /// @notice Per-input cap on a single {recycle}; 0 disables recycling of that input.
    mapping(address token => uint256) public maxRecycleIn;
    /// @notice Non-$GAME tokens held here (e.g. donated WETH) that keepers may recycle.
    mapping(address token => bool) public isRecycleInput;
    /// @notice Minimum time between two {recycle} calls.
    uint256 public minRecycleInterval;
    /// @notice Timestamp of the last {recycle}.
    uint256 public lastRecycleAt;

    event RevenueDistributed(
        uint256 amount, uint256 toStockBudget, uint256 toPrizeVault, uint256 burned, uint256 toTournament, uint256 toTreasury
    );
    event Burned(uint256 amount, bool viaBurnFunction);
    event Recycled(
        address indexed keeper, address indexed tokenIn, address indexed stockOut, uint256 amountIn, uint256 amountOut
    );
    event StockBudgetSynced(uint256 added, uint256 stockBudget);
    event SplitUpdated(Split split);
    event TournamentUpdated(address indexed tournament);
    event TreasuryUpdated(address indexed treasury);
    event SwapAdapterUpdated(address indexed swapAdapter);
    event RecycleInputUpdated(address indexed token, bool allowed);
    event MaxRecycleInUpdated(address indexed token, uint256 maxAmountIn);
    event MinRecycleIntervalUpdated(uint256 interval);

    error ZeroAddress();
    error ZeroAmount();
    error NotAContract(address account);
    error InvalidSplit();
    error InvalidInterval();
    error RevenueNotReceived(uint256 amount);
    error InvalidRecycleInput(address token);
    error InvalidStockOut(address token);
    error ExceedsStockBudget(uint256 amountIn, uint256 stockBudget);
    error ExceedsMaxRecycleIn(uint256 amountIn, uint256 maxAmountIn);
    error RecycleTooSoon(uint256 nextAllowedAt);
    error SwapAdapterNotSet();
    error InsufficientOutput(uint256 received, uint256 minAmountOut);

    /// @param admin Receives `DEFAULT_ADMIN_ROLE`.
    /// @param gameToken_ The $GAME token.
    /// @param prizeVault_ Prize vault (this router must be allowed to `fund` it: $GAME and stocks registered).
    /// @param tournament_ Tournament contract, or zero to route its bucket to the prize vault.
    /// @param treasury_ Treasury address.
    constructor(address admin, IERC20 gameToken_, IPrizeVault prizeVault_, ITournament tournament_, address treasury_) {
        if (admin == address(0) || address(gameToken_) == address(0) || address(prizeVault_) == address(0)) {
            revert ZeroAddress();
        }
        gameToken = gameToken_;
        prizeVault = prizeVault_;
        gameToken_.forceApprove(address(prizeVault_), type(uint256).max);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setTournament(tournament_);
        _setTreasury(treasury_);
        _setSplit(Split({stockBps: 3000, vaultBps: 3500, burnBps: 1500, tournamentBps: 1000, treasuryBps: 1000}));
        _setMinRecycleInterval(1 hours);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Revenue
    // ------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IRevenueRouter
    /// @dev The caller transfers `amount` of $GAME here first; the router checks it holds at least
    ///      `stockBudget + amount` so accounting can never exceed holdings.
    function distribute(uint256 amount) external onlyRole(GAME_ROLE) nonReentrant {
        if (amount == 0) return;
        if (gameToken.balanceOf(address(this)) < stockBudget + amount) revert RevenueNotReceived(amount);

        Split memory s = _split;
        uint256 toStock = (amount * s.stockBps) / BPS;
        uint256 toBurn = (amount * s.burnBps) / BPS;
        uint256 toTournament = (amount * s.tournamentBps) / BPS;
        uint256 toTreasury = (amount * s.treasuryBps) / BPS;
        ITournament t = tournament;
        if (address(t) == address(0)) toTournament = 0;
        uint256 toVault = amount - toStock - toBurn - toTournament - toTreasury;

        stockBudget += toStock;
        totalRevenue += SafeCast.toUint128(amount);
        totalBurned += SafeCast.toUint128(toBurn);

        if (toBurn != 0) _burn(toBurn);
        if (toTreasury != 0) gameToken.safeTransfer(treasury, toTreasury);
        if (toTournament != 0) t.notifyReward(toTournament);
        if (toVault != 0) prizeVault.fund(address(gameToken), toVault);

        emit RevenueDistributed(amount, toStock, toVault, toBurn, toTournament, toTreasury);
    }

    /// @notice Adds $GAME sent here by plain transfer (donations) to the stock budget. Callable by anyone.
    /// @return added Amount added to {stockBudget}.
    function syncStockBudget() external nonReentrant returns (uint256 added) {
        uint256 balance = gameToken.balanceOf(address(this));
        uint256 budget = stockBudget;
        if (balance <= budget) return 0;
        added = balance - budget;
        stockBudget = balance;
        emit StockBudgetSynced(added, balance);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Recycling
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Swaps revenue into a registered stock token and deposits it into that stock's prize pool.
    /// @param tokenIn $GAME (limited to {stockBudget}) or an allowed recycle input such as WETH.
    /// @param stockOut Registered, non-$GAME reward token to buy.
    /// @param amountIn Amount of `tokenIn` to sell (<= {maxRecycleIn}).
    /// @param minAmountOut Minimum stock tokens to receive (> 0); checked against the actual balance delta.
    /// @param swapData Adapter-specific routing data (UniswapV3Adapter: packed V3 path from `tokenIn` to `stockOut`).
    /// @return amountOut Stock tokens deposited into the vault.
    function recycle(address tokenIn, address stockOut, uint256 amountIn, uint256 minAmountOut, bytes calldata swapData)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (uint256 amountOut)
    {
        if (amountIn == 0 || minAmountOut == 0) revert ZeroAmount();
        ISwapAdapter adapter = swapAdapter;
        if (address(adapter) == address(0)) revert SwapAdapterNotSet();
        if (tokenIn == address(gameToken)) {
            uint256 budget = stockBudget;
            if (amountIn > budget) revert ExceedsStockBudget(amountIn, budget);
            stockBudget = budget - amountIn;
        } else if (!isRecycleInput[tokenIn]) {
            revert InvalidRecycleInput(tokenIn);
        }
        uint256 cap = maxRecycleIn[tokenIn];
        if (amountIn > cap) revert ExceedsMaxRecycleIn(amountIn, cap);
        uint256 nextAllowedAt = lastRecycleAt + minRecycleInterval;
        if (lastRecycleAt != 0 && block.timestamp < nextAllowedAt) revert RecycleTooSoon(nextAllowedAt);
        if (stockOut == address(gameToken) || stockOut == tokenIn || !prizeVault.isRegistered(stockOut)) {
            revert InvalidStockOut(stockOut);
        }
        lastRecycleAt = block.timestamp;

        IERC20 stock = IERC20(stockOut);
        uint256 balanceBefore = stock.balanceOf(address(this));
        IERC20(tokenIn).forceApprove(address(adapter), amountIn);
        adapter.swap(tokenIn, stockOut, amountIn, minAmountOut, address(this), swapData);
        IERC20(tokenIn).forceApprove(address(adapter), 0);
        amountOut = stock.balanceOf(address(this)) - balanceBefore;
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        stock.forceApprove(address(prizeVault), amountOut);
        prizeVault.fund(stockOut, amountOut);
        emit Recycled(msg.sender, tokenIn, stockOut, amountIn, amountOut);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Updates the revenue split (see contract docs for bounds).
    function setSplit(Split calldata split_) external onlyRole(CONFIG_ROLE) {
        _setSplit(split_);
    }

    /// @notice Sets the per-call recycling cap for `token` (0 disables it as an input).
    function setMaxRecycleIn(address token, uint256 maxAmountIn) external onlyRole(CONFIG_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        maxRecycleIn[token] = maxAmountIn;
        emit MaxRecycleInUpdated(token, maxAmountIn);
    }

    /// @notice Allows or disallows a non-$GAME token held by the router (e.g. WETH) as a recycle input.
    function setRecycleInput(address token, bool allowed) external onlyRole(CONFIG_ROLE) {
        if (token == address(0) || token == address(gameToken)) revert InvalidRecycleInput(token);
        isRecycleInput[token] = allowed;
        emit RecycleInputUpdated(token, allowed);
    }

    /// @notice Sets the minimum time between recycles (<= 7 days).
    function setMinRecycleInterval(uint256 interval) external onlyRole(CONFIG_ROLE) {
        _setMinRecycleInterval(interval);
    }

    /// @notice Sets the swap venue used by {recycle}.
    function setSwapAdapter(ISwapAdapter adapter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireContract(address(adapter));
        swapAdapter = adapter;
        emit SwapAdapterUpdated(address(adapter));
    }

    /// @notice Sets (or disables, with zero) the tournament receiving its bucket.
    function setTournament(ITournament tournament_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTournament(tournament_);
    }

    /// @notice Sets the treasury address.
    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTreasury(treasury_);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Current revenue split.
    function split() external view returns (Split memory) {
        return _split;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------------------------

    /// @dev Burns via `ERC20Burnable.burn` when $GAME supports it, otherwise sends to {DEAD}.
    function _burn(uint256 amount) private {
        try ERC20Burnable(address(gameToken)).burn(amount) {
            emit Burned(amount, true);
        } catch {
            gameToken.safeTransfer(DEAD, amount);
            emit Burned(amount, false);
        }
    }

    function _setSplit(Split memory s) private {
        uint256 sum = uint256(s.stockBps) + s.vaultBps + s.burnBps + s.tournamentBps + s.treasuryBps;
        if (
            sum != BPS || s.stockBps < MIN_STOCK_BPS || uint256(s.burnBps) + s.treasuryBps > MAX_BURN_PLUS_TREASURY_BPS
                || s.treasuryBps > MAX_TREASURY_BPS
        ) revert InvalidSplit();
        _split = s;
        emit SplitUpdated(s);
    }

    function _setTournament(ITournament tournament_) private {
        address previous = address(tournament);
        if (previous != address(0)) gameToken.forceApprove(previous, 0);
        if (address(tournament_) != address(0)) {
            _requireContract(address(tournament_));
            gameToken.forceApprove(address(tournament_), type(uint256).max);
        }
        tournament = tournament_;
        emit TournamentUpdated(address(tournament_));
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function _setMinRecycleInterval(uint256 interval) private {
        if (interval > MAX_RECYCLE_INTERVAL) revert InvalidInterval();
        minRecycleInterval = interval;
        emit MinRecycleIntervalUpdated(interval);
    }

    function _requireContract(address account) private view {
        if (account.code.length == 0) revert NotAContract(account);
    }
}
