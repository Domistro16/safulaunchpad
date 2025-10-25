// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title LaunchpadTokenV2
 * @dev BEP20 token with transfer lock and metadata support
 * UPDATED: Transfers are locked until graduation
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
    
    // Transfer lock mechanism
    bool public transfersEnabled;
    mapping(address => bool) public isExemptFromLock;

    event TransfersEnabled(uint256 timestamp);
    event ExemptionUpdated(address indexed account, bool exempt);

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
        transfersEnabled = false; // Locked by default
        
        // Owner and this contract are exempt from lock
        isExemptFromLock[initialOwner] = true;
        isExemptFromLock[address(this)] = true;
        
        _mint(initialOwner, totalSupply);
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    /**
     * @dev Override transfer to implement lock mechanism
     */
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        // Allow minting (from == address(0))
        // Allow burning (to == address(0))
        // Allow transfers if enabled OR if sender/receiver is exempt
        if (from != address(0) && to != address(0)) {
            require(
                transfersEnabled || isExemptFromLock[from] || isExemptFromLock[to],
                "Transfers are locked until graduation"
            );
        }
        
        super._update(from, to, amount);
    }

    /**
     * @dev Enable transfers permanently (can only be called once)
     * Only owner (LaunchpadManager) can call this at graduation
     */
    function enableTransfers() external onlyOwner {
        require(!transfersEnabled, "Transfers already enabled");
        transfersEnabled = true;
        emit TransfersEnabled(block.timestamp);
    }

    /**
     * @dev Set exemption status for an address
     * Used to exempt bonding curve contract, PancakeSwap, etc.
     */
    function setExemption(address account, bool exempt) external onlyOwner {
        isExemptFromLock[account] = exempt;
        emit ExemptionUpdated(account, exempt);
    }

    /**
     * @dev Batch set exemptions (gas optimization)
     */
    function setExemptions(address[] calldata accounts, bool exempt) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) {
            isExemptFromLock[accounts[i]] = exempt;
            emit ExemptionUpdated(accounts[i], exempt);
        }
    }

    function updateMetadata(TokenMetadata memory _metadata) external onlyOwner {
        metadata = _metadata;
    }

    function getMetadata() external view returns (TokenMetadata memory) {
        return metadata;
    }

    function burn(uint256 amount) external {
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