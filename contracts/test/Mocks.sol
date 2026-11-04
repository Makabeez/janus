// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Test-only. Minimal ERC-20 standing in for the wUSDC wrapper (6 decimals).
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public constant decimals = 6;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address s, uint256 amt) external returns (bool) {
        allowance[msg.sender][s] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "bal");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address f, address to, uint256 amt) external returns (bool) {
        require(allowance[f][msg.sender] >= amt, "allow");
        require(balanceOf[f] >= amt, "bal");
        allowance[f][msg.sender] -= amt;
        balanceOf[f] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// Test-only. Mimics PriceBook: `entryOf` serves the committed entry; `refreshAll`
/// commits the "live Solana account" value staged with `stage` (if newer), or
/// reverts when `refreshReverts` is set (like AllFeedsFaulted).
contract MockBook {
    int256 public answer;
    uint64 public publishTime;
    uint8 public status;

    int256 public stagedAnswer;
    uint64 public stagedTime;
    bool public refreshReverts;

    function commit(int256 a, uint64 pt) external {
        answer = a;
        publishTime = pt;
        status = 1;
    }

    function stage(int256 a, uint64 pt) external {
        stagedAnswer = a;
        stagedTime = pt;
    }

    function setRefreshReverts(bool v) external {
        refreshReverts = v;
    }

    function setStatus(uint8 s) external {
        status = s;
    }

    function refreshAll(bytes32[] calldata) external returns (uint256, uint256, uint256) {
        require(!refreshReverts, "AllFeedsFaulted");
        if (stagedTime > publishTime && stagedTime <= block.timestamp) {
            answer = stagedAnswer;
            publishTime = stagedTime;
            status = 1;
            return (1, 0, 0);
        }
        return (0, 1, 0);
    }

    function entryOf(bytes32) external view returns (int256, uint64, uint64, uint8) {
        return (answer, publishTime, publishTime, status);
    }
}
