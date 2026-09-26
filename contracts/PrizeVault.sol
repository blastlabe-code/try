// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPrizeVault} from "./interfaces/IPrizeVault.sol";
import {IClaimGate} from "./interfaces/IClaimGate.sol";

/// @title PrizeVault
/// @notice Custodies every prize token with strict accounting: a live prize pool per token (`poolAvailable`) that
///         payouts are drawn from as a fraction, and per-player `owed` balances that only the player can withdraw.
/// @dev Invariant, for every registered token: `balanceOf(vault) >= poolAvailable[token] + totalOwed[token]`.
///      Owed balances are untouchable by the admin; claims can never be paused. The admin can only withdraw
///      *available* pool funds, through a public 7-day timelock.
contract PrizeVault is AccessControl, ReentrancyGuardTransient, IPrizeVault {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to credit prizes (the FishingGame).
    bytes32 public constant GAME_ROLE = keccak256("GAME_ROLE");

    /// @notice Share denominator (parts per million).
    uint256 public constant PPM = 1_000_000;
    /// @notice Maximum number of registered reward tokens ($GAME + stocks).
    uint256 public constant MAX_TOKENS = 16;
    /// @notice Hard cap on a single credit (10% of a pool) as defence in depth; the game caps lower (maxSharePpm).
    uint256 public constant MAX_CREDIT_PPM = 100_000;
    /// @notice Delay between scheduling and executing an emergency withdrawal.
    uint256 public constant EMERGENCY_DELAY = 7 days;
    /// @notice Window after the delay during which a scheduled withdrawal can be executed before it expires.
    uint256 public constant EMERGENCY_WINDOW = 7 days;

    /// @notice A scheduled withdrawal of available (never owed) pool funds.
    struct EmergencyWithdrawal {
        address token;
        uint64 executableAt;
        bool settled;
        address to;
        uint256 amount;
    }

    address[] private _tokens;

    /// @inheritdoc IPrizeVault
    mapping(address token => bool) public isRegistered;
    /// @inheritdoc IPrizeVault
    mapping(address token => uint256) public poolAvailable;
    /// @notice Sum of all players' owed balances of a token.
    mapping(address token => uint256) public totalOwed;
    /// @notice Claimable balance of `player` in `token`.
    mapping(address player => mapping(address token => uint256)) public owed;

    /// @notice Optional compliance hook; zero address disables it.
    IClaimGate public claimGate;

    /// @notice Scheduled emergency withdrawals by id (ids start at 1).
    mapping(uint256 id => EmergencyWithdrawal) public emergencyWithdrawals;
    /// @notice Number of emergency withdrawals ever scheduled (= last id).
    uint256 public emergencyWithdrawalCount;

    event TokenRegistered(address indexed token);
    event Funded(address indexed token, address indexed from, uint256 amount);
    event Synced(address indexed token, uint256 amount);
    event Credited(address indexed player, address indexed token, uint256 amount, uint256 poolAfter);
    event Claimed(address indexed player, address indexed token, uint256 amount);
    event ClaimGateUpdated(address indexed claimGate);
    event EmergencyWithdrawScheduled(
        uint256 indexed id, address indexed token, address indexed to, uint256 amount, uint256 executableAt
    );
    event EmergencyWithdrawCancelled(uint256 indexed id);
    event EmergencyWithdrawExecuted(uint256 indexed id, address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error TokenAlreadyRegistered(address token);
    error TokenNotRegistered(address token);
    error TooManyTokens();
    error NothingToClaim();
    error ClaimNotAllowed(address player);
    error UnknownWithdrawal(uint256 id);
    error WithdrawalSettled(uint256 id);
    error WithdrawalNotReady(uint256 id, uint256 executableAt);
    error WithdrawalExpired(uint256 id);
    error InsufficientAvailable(address token, uint256 requested, uint256 available);

    /// @param admin Receives `DEFAULT_ADMIN_ROLE` (intended: a TimelockController owned by a multisig).
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Funding
    // ------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IPrizeVault
    /// @dev Credits the balance actually received, so fee-on-transfer tokens cannot inflate the pool.
    function fund(address token, uint256 amount) external nonReentrant {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (amount == 0) revert ZeroAmount();
        IERC20 erc20 = IERC20(token);
        uint256 balanceBefore = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = erc20.balanceOf(address(this)) - balanceBefore;
        poolAvailable[token] += received;
        emit Funded(token, msg.sender, received);
    }

    /// @notice Adds tokens sent to the vault by plain transfer (donations) to the prize pool.
    /// @param token Registered token to reconcile.
    /// @return added Amount moved into `poolAvailable`.
    function sync(address token) external returns (uint256 added) {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        uint256 accounted = poolAvailable[token] + totalOwed[token];
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance <= accounted) return 0;
        added = balance - accounted;
        poolAvailable[token] += added;
        emit Synced(token, added);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Crediting (game only)
    // ------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IPrizeVault
    function credit(address player, address token, uint256 sharePpm)
        external
        onlyRole(GAME_ROLE)
        returns (uint256 amount)
    {
        if (!isRegistered[token]) return 0;
        return _credit(player, token, sharePpm);
    }

    /// @inheritdoc IPrizeVault
    function creditAll(address player, uint256 sharePpm)
        external
        onlyRole(GAME_ROLE)
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        tokens = _tokens;
        amounts = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            amounts[i] = _credit(player, tokens[i], sharePpm);
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Claims (never pausable)
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Withdraws the caller's owed balances of `tokens` (tokens with nothing owed are skipped).
    /// @dev Use this instead of {claimAll} to skip a token whose transfers are temporarily failing.
    function claim(address[] calldata tokens) external nonReentrant {
        _claim(msg.sender, tokens);
    }

    /// @notice Withdraws the caller's owed balances of every registered token.
    function claimAll() external nonReentrant {
        _claim(msg.sender, _tokens);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Registers a reward token ($GAME or a stock token). At most {MAX_TOKENS}; cannot be undone.
    function registerToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (isRegistered[token]) revert TokenAlreadyRegistered(token);
        if (_tokens.length >= MAX_TOKENS) revert TooManyTokens();
        isRegistered[token] = true;
        _tokens.push(token);
        emit TokenRegistered(token);
    }

    /// @notice Sets (or clears, with the zero address) the compliance hook consulted on every claim.
    function setClaimGate(IClaimGate gate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        claimGate = gate;
        emit ClaimGateUpdated(address(gate));
    }

    /// @notice Announces a withdrawal of *available* pool funds, executable after {EMERGENCY_DELAY}.
    /// @return id Id to pass to {executeEmergencyWithdraw} / {cancelEmergencyWithdraw}.
    function scheduleEmergencyWithdraw(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint256 id)
    {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        id = ++emergencyWithdrawalCount;
        uint256 executableAt = block.timestamp + EMERGENCY_DELAY;
        emergencyWithdrawals[id] = EmergencyWithdrawal({
            token: token,
            executableAt: uint64(executableAt),
            settled: false,
            to: to,
            amount: amount
        });
        emit EmergencyWithdrawScheduled(id, token, to, amount, executableAt);
    }

    /// @notice Cancels a scheduled emergency withdrawal.
    function cancelEmergencyWithdraw(uint256 id) external onlyRole(DEFAULT_ADMIN_ROLE) {
        EmergencyWithdrawal storage w = _pendingWithdrawal(id);
        w.settled = true;
        emit EmergencyWithdrawCancelled(id);
    }

    /// @notice Executes a scheduled withdrawal once its delay has passed (and before it expires).
    /// @dev Draws only from `poolAvailable`; owed balances can never be touched.
    function executeEmergencyWithdraw(uint256 id) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        EmergencyWithdrawal storage w = _pendingWithdrawal(id);
        uint256 executableAt = w.executableAt;
        if (block.timestamp < executableAt) revert WithdrawalNotReady(id, executableAt);
        if (block.timestamp > executableAt + EMERGENCY_WINDOW) revert WithdrawalExpired(id);
        address token = w.token;
        uint256 amount = w.amount;
        uint256 available = poolAvailable[token];
        if (amount > available) revert InsufficientAvailable(token, amount, available);
        w.settled = true;
        poolAvailable[token] = available - amount;
        IERC20(token).safeTransfer(w.to, amount);
        emit EmergencyWithdrawExecuted(id, token, w.to, amount);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Registered reward tokens, in registration order.
    function registeredTokens() external view returns (address[] memory) {
        return _tokens;
    }

    /// @notice Number of registered reward tokens.
    function tokenCount() external view returns (uint256) {
        return _tokens.length;
    }

    /// @notice Prize pool size of every registered token.
    function poolBalances() external view returns (address[] memory tokens, uint256[] memory available) {
        tokens = _tokens;
        available = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            available[i] = poolAvailable[tokens[i]];
        }
    }

    /// @notice Owed (claimable) balance of `player` in every registered token.
    function owedBalances(address player) external view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens;
        amounts = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            amounts[i] = owed[player][tokens[i]];
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------------------------

    function _credit(address player, address token, uint256 sharePpm) private returns (uint256 amount) {
        if (sharePpm > MAX_CREDIT_PPM) sharePpm = MAX_CREDIT_PPM;
        uint256 available = poolAvailable[token];
        amount = (available * sharePpm) / PPM;
        if (amount == 0) return 0;
        uint256 poolAfter = available - amount;
        poolAvailable[token] = poolAfter;
        owed[player][token] += amount;
        totalOwed[token] += amount;
        emit Credited(player, token, amount, poolAfter);
    }

    function _claim(address player, address[] memory tokens) private {
        IClaimGate gate = claimGate;
        if (address(gate) != address(0) && !gate.canClaim(player)) revert ClaimNotAllowed(player);
        bool claimedAny;
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            uint256 amount = owed[player][token];
            if (amount == 0) continue;
            owed[player][token] = 0;
            totalOwed[token] -= amount;
            claimedAny = true;
            IERC20(token).safeTransfer(player, amount);
            emit Claimed(player, token, amount);
        }
        if (!claimedAny) revert NothingToClaim();
    }

    function _pendingWithdrawal(uint256 id) private view returns (EmergencyWithdrawal storage w) {
        w = emergencyWithdrawals[id];
        if (w.token == address(0)) revert UnknownWithdrawal(id);
        if (w.settled) revert WithdrawalSettled(id);
    }
}
