// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockPancakeFactory {
    mapping(address => mapping(address => address)) public pairs;
    address[] public allPairs;

    event PairCreated(
        address indexed token0,
        address indexed token1,
        address pair,
        uint
    );

    function getPair(
        address tokenA,
        address tokenB
    ) external view returns (address) {
        address pair = pairs[tokenA][tokenB];
        if (pair == address(0)) {
            pair = pairs[tokenB][tokenA];
        }
        return pair;
    }

    function createPair(
        address tokenA,
        address tokenB
    ) external returns (address pair) {
        require(tokenA != tokenB, "Identical addresses");
        require(tokenA != address(0) && tokenB != address(0), "Zero address");
        require(pairs[tokenA][tokenB] == address(0), "Pair exists");

        // Ensure consistent ordering (token0 < token1)
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        // Create a mock LP token contract
        MockPancakePair pairContract = new MockPancakePair(token0, token1);
        pair = address(pairContract);

        pairs[token0][token1] = pair;
        pairs[token1][token0] = pair;
        allPairs.push(pair);

        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function allPairsLength() external view returns (uint) {
        return allPairs.length;
    }
}

// Mock LP Token
contract MockPancakePair {
    string public constant name = "Pancake LPs";
    string public constant symbol = "Cake-LP";
    uint8 public constant decimals = 18;

    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;

        // Initialize with some mock reserves
        reserve0 = 1000000;
        reserve1 = 1000000;
        blockTimestampLast = uint32(block.timestamp);
    }

    // ✅ Required by LPFeeHarvester
    function getReserves()
        external
        view
        returns (
            uint112 _reserve0,
            uint112 _reserve1,
            uint32 _blockTimestampLast
        )
    {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    // ✅ Update reserves when liquidity is added
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;

        // // Update reserves proportionally (simplified)
        // reserve0 += uint112(amount / 2);
        // reserve1 += uint112(amount / 2);
        blockTimestampLast = uint32(block.timestamp);

        emit Transfer(address(0), to, amount);
        // emit Sync(reserve0, reserve1);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        require(
            allowance[from][msg.sender] >= amount,
            "Insufficient allowance"
        );
        require(balanceOf[from] >= amount, "Insufficient balance");

        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    // ✅ Helper to manually set reserves for testing
    function setReserves(uint112 _reserve0, uint112 _reserve1) external {
        reserve0 = _reserve0;
        reserve1 = _reserve1;
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }
}
