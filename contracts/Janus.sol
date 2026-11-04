// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Read + permissionless-refresh surface of Rome's Oracle Gateway PriceBook.
/// `refreshAll` pulls the latest Pyth PriceUpdateV2 account from Solana into the book;
/// `entryOf` returns the book's current entry (8-decimal price, Pyth publish time, status).
interface IPriceBook {
    function refreshAll(bytes32[] calldata sourceAccounts)
        external
        returns (uint256 committed, uint256 skipped, uint256 faulted);

    function entryOf(bytes32 sourceAccount)
        external
        view
        returns (int256 answer, uint64 publishTime, uint64 cachedAt, uint8 status);
}

/// @title Janus — BTC UP/DOWN rounds for both wallet lanes on Rome
/// @notice Pari-mutuel binary rounds. During round r's betting window anyone (a MetaMask
///         address or a Solana wallet's synthetic address — the contract cannot tell and
///         does not care) stakes wUSDC on UP or DOWN. Betting closes at lockAt(r). The
///         strike is the first Pyth print at or after lockAt(r); the close is the first
///         print at or after expiry(r) = lockAt(r) + interval. Winners split the pool,
///         minus a fee, pro rata to their stake.
///
///         Price integrity rules:
///         - bets close BEFORE the strike exists, so a bettor never sees the strike;
///         - lock/settle refresh the PriceBook themselves (permissionless) and accept only
///           a print whose publish time is in [T, T + tolerance];
///         - no qualifying print inside the window -> the round is void and fully refunded;
///         - a one-sided round (no counterparty) or a flat close is void and refunded.
///
///         Residual risk (documented, not hidden): the book keeps only its latest print, so
///         if several prints land inside [T, T + tolerance] before anyone locks, the caller
///         chooses which one is used. The keeper locks on the first print to close that gap.
contract Janus {
    enum Status {
        Open, // betting (before lockAt) or awaiting the strike print
        Locked, // strike set, awaiting the close print
        Settled, // close set, winners can claim
        Void // refunded
    }

    struct Round {
        uint128 upPool;
        uint128 downPool;
        int64 strike; // 8 decimals
        int64 closePrice; // 8 decimals
        uint64 strikeTime; // Pyth publish time of the strike print
        uint64 closeTime; // Pyth publish time of the close print
        uint128 payoutPool; // pool minus fee, set at settlement
        Status status;
        bool upWon;
    }

    IERC20 public immutable token; // wUSDC wrapper (6 decimals)
    IPriceBook public immutable book;
    bytes32 public immutable feed; // Solana Pyth PriceUpdateV2 account registered in the book
    uint64 public immutable genesis; // start of round 0
    uint64 public immutable interval; // betting window == live window length, seconds
    uint64 public immutable tolerance; // max delay of a qualifying print after its target time
    uint256 public immutable minBet; // in token units
    uint16 public immutable feeBps;
    address public immutable treasury;

    mapping(uint256 => Round) internal _rounds;
    mapping(uint256 => mapping(address => uint256)) public upStake;
    mapping(uint256 => mapping(address => uint256)) public downStake;
    mapping(uint256 => mapping(address => bool)) public claimed;

    uint256 private _lock = 1;

    event BetPlaced(uint256 indexed round, address indexed who, bool up, uint256 amount);
    event RoundLocked(uint256 indexed round, int64 strike, uint64 publishTime);
    event RoundSettled(uint256 indexed round, int64 closePrice, uint64 publishTime, bool upWon, uint256 fee);
    event RoundVoided(uint256 indexed round, string reason);
    event Claimed(address indexed who, uint256 indexed round, uint256 amount);

    error RoundNotOpenForBets(uint256 round, uint256 current);
    error BetTooSmall(uint256 amount, uint256 minBet);
    error BetTooLarge(uint256 amount);
    error WrongStatus(uint256 round, Status status);
    error TooEarly(uint256 round, uint256 notBefore);
    error NoPrintYet(uint64 publishTime, uint64 target);
    error NothingToClaim();
    error TransferFailed();
    error Reentrancy();
    error BadConfig();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        IERC20 _token,
        IPriceBook _book,
        bytes32 _feed,
        uint64 _genesis,
        uint64 _interval,
        uint64 _tolerance,
        uint256 _minBet,
        uint16 _feeBps,
        address _treasury
    ) {
        if (_interval == 0 || _tolerance == 0 || _tolerance >= _interval || _feeBps > 1000) revert BadConfig();
        if (address(_token) == address(0) || address(_book) == address(0) || _treasury == address(0)) revert BadConfig();
        token = _token;
        book = _book;
        feed = _feed;
        genesis = _genesis;
        interval = _interval;
        tolerance = _tolerance;
        minBet = _minBet;
        feeBps = _feeBps;
        treasury = _treasury;
    }

    // ───────────────────────────── schedule ─────────────────────────────

    function currentRound() public view returns (uint256) {
        if (block.timestamp < genesis) return 0;
        return (block.timestamp - genesis) / interval;
    }

    function startAt(uint256 r) public view returns (uint64) {
        return uint64(genesis + r * interval);
    }

    function lockAt(uint256 r) public view returns (uint64) {
        return uint64(genesis + (r + 1) * interval);
    }

    function expiryAt(uint256 r) public view returns (uint64) {
        return uint64(genesis + (r + 2) * interval);
    }

    function getRound(uint256 r) external view returns (Round memory) {
        return _rounds[r];
    }

    // ───────────────────────────── betting ─────────────────────────────

    /// @param r must equal currentRound(): a tx that lands after the window reverts
    ///          instead of silently entering the next round.
    function bet(uint256 r, bool up, uint256 amount) external nonReentrant {
        if (block.timestamp < genesis || r != currentRound()) revert RoundNotOpenForBets(r, currentRound());
        if (amount < minBet) revert BetTooSmall(amount, minBet);
        // wUSDC is an SPL token (u64 amounts); bounding here also makes the uint128 pool casts exact.
        if (amount > type(uint64).max) revert BetTooLarge(amount);
        Round storage rd = _rounds[r];
        if (rd.status != Status.Open) revert WrongStatus(r, rd.status);

        if (up) {
            rd.upPool += uint128(amount);
            upStake[r][msg.sender] += amount;
        } else {
            rd.downPool += uint128(amount);
            downStake[r][msg.sender] += amount;
        }
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit BetPlaced(r, msg.sender, up, amount);
    }

    // ───────────────────────────── oracle ─────────────────────────────

    /// Pull the newest Pyth print into the book (best effort: a faulted or skipped refresh
    /// still leaves the current entry readable), then return it.
    function _freshPrint() internal returns (int64 price, uint64 publishTime) {
        bytes32[] memory accts = new bytes32[](1);
        accts[0] = feed;
        try book.refreshAll(accts) {} catch {}
        (int256 answer, uint64 pt,, uint8 st) = book.entryOf(feed);
        if (st != 1 || answer <= 0 || answer > type(int64).max) return (0, 0);
        return (int64(answer), pt);
    }

    // ───────────────────────────── lifecycle (permissionless) ─────────────────────────────

    function lock(uint256 r) external nonReentrant {
        Round storage rd = _rounds[r];
        if (rd.status != Status.Open) revert WrongStatus(r, rd.status);
        uint64 target = lockAt(r);
        if (block.timestamp < target) revert TooEarly(r, target);
        if (block.timestamp > uint256(target) + tolerance) return _void(r, "no strike print in window");
        if (rd.upPool == 0 || rd.downPool == 0) return _void(r, "one-sided round");

        (int64 price, uint64 pt) = _freshPrint();
        if (pt < target) revert NoPrintYet(pt, target);
        // pt <= block.timestamp <= target + tolerance (the book rejects future prints)
        rd.strike = price;
        rd.strikeTime = pt;
        rd.status = Status.Locked;
        emit RoundLocked(r, price, pt);
    }

    function settle(uint256 r) external nonReentrant {
        Round storage rd = _rounds[r];
        if (rd.status != Status.Locked) revert WrongStatus(r, rd.status);
        uint64 target = expiryAt(r);
        if (block.timestamp < target) revert TooEarly(r, target);
        if (block.timestamp > uint256(target) + tolerance) return _void(r, "no close print in window");

        (int64 price, uint64 pt) = _freshPrint();
        if (pt < target) revert NoPrintYet(pt, target);
        if (price == rd.strike) return _void(r, "flat close");

        uint256 pool = uint256(rd.upPool) + uint256(rd.downPool);
        uint256 fee = (pool * feeBps) / 10_000;
        rd.closePrice = price;
        rd.closeTime = pt;
        rd.upWon = price > rd.strike;
        rd.payoutPool = uint128(pool - fee);
        rd.status = Status.Settled;
        if (fee > 0 && !token.transfer(treasury, fee)) revert TransferFailed();
        emit RoundSettled(r, price, pt, rd.upWon, fee);
    }

    /// Anyone can void a round whose print window has passed without a lock/settle.
    function voidRound(uint256 r) external nonReentrant {
        Round storage rd = _rounds[r];
        if (rd.status == Status.Open && block.timestamp > uint256(lockAt(r)) + tolerance) {
            return _void(r, "no strike print in window");
        }
        if (rd.status == Status.Locked && block.timestamp > uint256(expiryAt(r)) + tolerance) {
            return _void(r, "no close print in window");
        }
        revert WrongStatus(r, rd.status);
    }

    function _void(uint256 r, string memory reason) internal {
        _rounds[r].status = Status.Void;
        emit RoundVoided(r, reason);
    }

    // ───────────────────────────── claims ─────────────────────────────

    function claimable(uint256 r, address who) public view returns (uint256) {
        if (claimed[r][who]) return 0;
        Round storage rd = _rounds[r];
        if (rd.status == Status.Void) return upStake[r][who] + downStake[r][who];
        if (rd.status != Status.Settled) return 0;
        if (rd.upWon) {
            uint256 s = upStake[r][who];
            return s == 0 ? 0 : (s * rd.payoutPool) / rd.upPool;
        }
        uint256 d = downStake[r][who];
        return d == 0 ? 0 : (d * rd.payoutPool) / rd.downPool;
    }

    function claim(uint256[] calldata rs) external nonReentrant {
        uint256 total;
        for (uint256 i = 0; i < rs.length; i++) {
            uint256 amt = claimable(rs[i], msg.sender);
            if (amt == 0) continue;
            claimed[rs[i]][msg.sender] = true;
            total += amt;
            emit Claimed(msg.sender, rs[i], amt);
        }
        if (total == 0) revert NothingToClaim();
        if (!token.transfer(msg.sender, total)) revert TransferFailed();
    }
}
