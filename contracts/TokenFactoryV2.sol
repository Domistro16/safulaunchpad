// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title LaunchpadTokenV2
 * @dev BEP20 token with metadata support (non-upgradeable)
 * Note: Individual tokens don't need to be upgradeable
 */
contract LaunchpadTokenV2 is ERC20, Ownable {
    uint8 private _decimals;

    struct TokenMetadata {
        string logoURI;
        string description;
        string website;
        string twitter;
        string telegram;
        string discord;
    }

    TokenMetadata public metadata;

    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 decimalsValue,
        address initialOwner,
        TokenMetadata memory _metadata
    ) ERC20(name, symbol) Ownable(initialOwner) {
        _decimals = decimalsValue;
        metadata = _metadata;
        _mint(initialOwner, totalSupply);
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    function updateMetadata(TokenMetadata memory _metadata) external onlyOwner {
        metadata = _metadata;
    }

    function getMetadata() external view returns (TokenMetadata memory) {
        return metadata;
    }

    function burn(uint256 amount) external onlyOwner {
        _burn(msg.sender, amount);
    }
}

/**
 * @title TokenFactoryV2
 */
contract TokenFactoryV2 is Ownable {
    event TokenCreated(
        address indexed tokenAddress,
        address indexed creator,
        string name,
        string symbol,
        uint256 totalSupply,
        bytes32 salt
    );

    mapping(address => address[]) public creatorTokens;
    address[] public allTokens;

    constructor() Ownable(msg.sender) {}

    /**
     * @dev Create token with metadata
     */
    function createToken(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 decimals,
        address owner,
        LaunchpadTokenV2.TokenMetadata memory metadata
    ) external returns (address) {
        require(bytes(name).length > 0, "Name cannot be empty");
        require(bytes(symbol).length > 0, "Symbol cannot be empty");
        require(totalSupply > 0, "Total supply must be greater than 0");
        require(owner != address(0), "Owner cannot be zero address");

        LaunchpadTokenV2 token = new LaunchpadTokenV2(
            name,
            symbol,
            totalSupply * 10 ** decimals,
            decimals,
            owner,
            metadata
        );

        address tokenAddress = address(token);
        _trackToken(tokenAddress);

        emit TokenCreated(
            tokenAddress,
            msg.sender,
            name,
            symbol,
            totalSupply,
            bytes32(0)
        );

        return tokenAddress;
    }

    /**
     * @dev Create token with CREATE2 for vanity address
     */
    function createTokenWithSalt(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 decimals,
        address owner,
        LaunchpadTokenV2.TokenMetadata memory metadata,
        bytes32 salt
    ) external returns (address) {
        require(bytes(name).length > 0, "Name cannot be empty");
        require(bytes(symbol).length > 0, "Symbol cannot be empty");
        require(totalSupply > 0, "Total supply must be greater than 0");
        require(owner != address(0), "Owner cannot be zero address");

        LaunchpadTokenV2 token = new LaunchpadTokenV2{salt: salt}(
            name,
            symbol,
            totalSupply * 10 ** decimals,
            decimals,
            owner,
            metadata
        );

        address tokenAddress = address(token);
        _trackToken(tokenAddress);

        emit TokenCreated(
            tokenAddress,
            msg.sender,
            name,
            symbol,
            totalSupply,
            salt
        );

        return tokenAddress;
    }

    /**
     * @dev Compute address that would be deployed with given salt
     */
    function computeAddress(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 decimals,
        address owner,
        LaunchpadTokenV2.TokenMetadata memory metadata,
        bytes32 salt
    ) external view returns (address) {
        bytes memory bytecode = abi.encodePacked(
            type(LaunchpadTokenV2).creationCode,
            abi.encode(
                name,
                symbol,
                totalSupply * 10 ** decimals,
                decimals,
                owner,
                metadata
            )
        );

        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                salt,
                keccak256(bytecode)
            )
        );

        return address(uint160(uint256(hash)));
    }

    function _trackToken(address tokenAddress) private {
        creatorTokens[msg.sender].push(tokenAddress);
        allTokens.push(tokenAddress);
    }

    function getCreatorTokens(
        address creator
    ) external view returns (address[] memory) {
        return creatorTokens[creator];
    }

    function getTotalTokens() external view returns (uint256) {
        return allTokens.length;
    }

    function getTokenAtIndex(uint256 index) external view returns (address) {
        require(index < allTokens.length, "Index out of bounds");
        return allTokens[index];
    }
}
