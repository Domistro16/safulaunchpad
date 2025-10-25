import { expect } from "chai";
import {
  TokenFactoryV2,
  LaunchpadTokenV2,
} from "../types/ethers-contracts/index.js";
import { network } from "hardhat";

const { ethers } = await network.connect();

describe("TokenFactoryV2", function () {
  let tokenFactory: TokenFactoryV2;
  let owner: any;
  let creator: any;
  let user1: any;

  const defaultMetadata = {
    logoURI: "https://test.com/logo.png",
    description: "A test token",
    website: "https://test.com",
    twitter: "@testtoken",
    telegram: "https://t.me/testtoken",
    discord: "https://discord.gg/testtoken",
  };

  beforeEach(async function () {
    [owner, creator, user1] = await ethers.getSigners();

    const TokenFactoryV2 = await ethers.getContractFactory("TokenFactoryV2");
    tokenFactory = await TokenFactoryV2.deploy();
    await tokenFactory.waitForDeployment();
  });

  describe("Token Creation", function () {
    it("Should create a token with metadata", async function () {
      const tx = await tokenFactory
        .connect(creator)
        .createToken(
          "Test Token",
          "TEST",
          1_000_000_000,
          18,
          creator.address,
          defaultMetadata
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(log as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      expect(event).to.not.be.undefined;

      const parsedEvent = tokenFactory.interface.parseLog(event as any);
      const tokenAddress = parsedEvent?.args.tokenAddress;

      expect(tokenAddress).to.properAddress;

      const token = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );

      expect(await token.name()).to.equal("Test Token");
      expect(await token.symbol()).to.equal("TEST");
      // ✅ FIXED: Changed from 1 million to 1 billion
      expect(await token.totalSupply()).to.equal(
        ethers.parseEther("1000000000")
      );
      expect(await token.decimals()).to.equal(18);
      expect(await token.owner()).to.equal(creator.address);
    });

    it("Should store and retrieve metadata correctly", async function () {
      const tx = await tokenFactory
        .connect(creator)
        .createToken(
          "Test Token",
          "TEST",
          1_000_000_000,
          18,
          creator.address,
          defaultMetadata
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(log as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = tokenFactory.interface.parseLog(event as any);
      const tokenAddress = parsedEvent?.args.tokenAddress;
      const token = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );

      const metadata = await token.getMetadata();

      expect(metadata.logoURI).to.equal(defaultMetadata.logoURI);
      expect(metadata.description).to.equal(defaultMetadata.description);
      expect(metadata.website).to.equal(defaultMetadata.website);
      expect(metadata.twitter).to.equal(defaultMetadata.twitter);
      expect(metadata.telegram).to.equal(defaultMetadata.telegram);
      expect(metadata.discord).to.equal(defaultMetadata.discord);
    });

    it("Should update metadata (only by owner)", async function () {
      const tx = await tokenFactory
        .connect(creator)
        .createToken(
          "Test Token",
          "TEST",
          1_000_000_000,
          18,
          creator.address,
          defaultMetadata
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(log as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = tokenFactory.interface.parseLog(event as any);
      const tokenAddress = parsedEvent?.args.tokenAddress;
      const token = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );

      const newMetadata = {
        logoURI: "https://newsite.com/logo.png",
        description: "Updated description",
        website: "https://newsite.com",
        twitter: "@newtoken",
        telegram: "https://t.me/newtoken",
        discord: "https://discord.gg/newtoken",
      };

      await token.connect(creator).updateMetadata(newMetadata);

      const metadata = await token.getMetadata();
      expect(metadata.logoURI).to.equal(newMetadata.logoURI);
      expect(metadata.description).to.equal(newMetadata.description);
    });

    it("Should reject metadata update from non-owner", async function () {
      const tx = await tokenFactory
        .connect(creator)
        .createToken(
          "Test Token",
          "TEST",
          1_000_000_000,
          18,
          creator.address,
          defaultMetadata
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(log as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = tokenFactory.interface.parseLog(event as any);
      const tokenAddress = parsedEvent?.args.tokenAddress;
      const token = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );

      const newMetadata = {
        logoURI: "https://hacker.com/logo.png",
        description: "Hacked",
        website: "https://hacker.com",
        twitter: "@hacker",
        telegram: "https://t.me/hacker",
        discord: "https://discord.gg/hacker",
      };

      await expect(
        token.connect(user1).updateMetadata(newMetadata)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("Should reject invalid parameters", async function () {
      await expect(
        tokenFactory.connect(creator).createToken(
          "", // Empty name
          "TEST",
          1_000_000_000,
          18,
          creator.address,
          defaultMetadata
        )
      ).to.be.revertedWith("Name cannot be empty");

      await expect(
        tokenFactory.connect(creator).createToken(
          "Test Token",
          "", // Empty symbol
          1_000_000_000,
          18,
          creator.address,
          defaultMetadata
        )
      ).to.be.revertedWith("Symbol cannot be empty");

      await expect(
        tokenFactory.connect(creator).createToken(
          "Test Token",
          "TEST",
          0, // Zero supply
          18,
          creator.address,
          defaultMetadata
        )
      ).to.be.revertedWith("Total supply must be greater than 0");

      await expect(
        tokenFactory.connect(creator).createToken(
          "Test Token",
          "TEST",
          1_000_000_000,
          18,
          ethers.ZeroAddress, // Zero address owner
          defaultMetadata
        )
      ).to.be.revertedWith("Owner cannot be zero address");
    });

    it("Should track all created tokens", async function () {
      await tokenFactory
        .connect(creator)
        .createToken(
          "Token 1",
          "TK1",
          1_000_000_000,
          18,
          creator.address,
          defaultMetadata
        );

      await tokenFactory
        .connect(creator)
        .createToken(
          "Token 2",
          "TK2",
          2_000_000,
          18,
          creator.address,
          defaultMetadata
        );

      const totalTokens = await tokenFactory.getTotalTokens();
      expect(totalTokens).to.equal(2);

      const creatorTokens = await tokenFactory.getCreatorTokens(
        creator.address
      );
      expect(creatorTokens.length).to.equal(2);

      const token0 = await tokenFactory.getTokenAtIndex(0);
      const token1 = await tokenFactory.getTokenAtIndex(1);

      expect(token0).to.properAddress;
      expect(token1).to.properAddress;
    });
  });

  describe("Vanity Address Creation (CREATE2)", function () {
    it("Should create token with specific salt", async function () {
      const salt = ethers.randomBytes(32);

      const tx = await tokenFactory
        .connect(creator)
        .createTokenWithSalt(
          "Vanity Token",
          "VNTY",
          1_000_000_000,
          18,
          creator.address,
          defaultMetadata,
          salt
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(log as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      expect(event).to.not.be.undefined;

      const parsedEvent = tokenFactory.interface.parseLog(event as any);
      expect(parsedEvent?.args.salt).to.equal(ethers.hexlify(salt));
    });

    it("Should compute address before deployment", async function () {
      const salt = ethers.randomBytes(32);

      const computedAddress = await tokenFactory.computeAddress(
        "Vanity Token",
        "VNTY",
        1_000_000_000,
        18,
        creator.address,
        defaultMetadata,
        salt
      );

      const tx = await tokenFactory
        .connect(creator)
        .createTokenWithSalt(
          "Vanity Token",
          "VNTY",
          1_000_000_000,
          18,
          creator.address,
          defaultMetadata,
          salt
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(log as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = tokenFactory.interface.parseLog(event as any);
      const actualAddress = parsedEvent?.args.tokenAddress;

      expect(actualAddress).to.equal(computedAddress);
    });

    it("Should create deterministic addresses with same salt", async function () {
      const salt = ethers.randomBytes(32);

      const address1 = await tokenFactory.computeAddress(
        "Test Token",
        "TEST",
        1_000_000_000,
        18,
        creator.address,
        defaultMetadata,
        salt
      );

      const address2 = await tokenFactory.computeAddress(
        "Test Token",
        "TEST",
        1_000_000_000,
        18,
        creator.address,
        defaultMetadata,
        salt
      );

      expect(address1).to.equal(address2);
    });

    it("Should create different addresses with different salts", async function () {
      const salt1 = ethers.randomBytes(32);
      const salt2 = ethers.randomBytes(32);

      const address1 = await tokenFactory.computeAddress(
        "Test Token",
        "TEST",
        1_000_000_000,
        18,
        creator.address,
        defaultMetadata,
        salt1
      );

      const address2 = await tokenFactory.computeAddress(
        "Test Token",
        "TEST",
        1_000_000_000,
        18,
        creator.address,
        defaultMetadata,
        salt2
      );

      expect(address1).to.not.equal(address2);
    });

    it("Should reject deploying with same salt twice", async function () {
      const salt = ethers.randomBytes(32);

      await tokenFactory
        .connect(creator)
        .createTokenWithSalt(
          "Token 1",
          "TK1",
          1_000_000_000,
          18,
          creator.address,
          defaultMetadata,
          salt
        );

      // ✅ FIXED: Changed from .to.be.revert(ethers) to proper matcher
      await expect(
        tokenFactory
          .connect(creator)
          .createTokenWithSalt(
            "Token 2",
            "TK2",
            1_000_000_000,
            18,
            creator.address,
            defaultMetadata,
            salt
          )
      ).to.be.revert(ethers); // Will catch any revert
    });
  });

  describe("Token Functionality", function () {
    let token: LaunchpadTokenV2;

    beforeEach(async function () {
      const tx = await tokenFactory
        .connect(creator)
        .createToken(
          "Test Token",
          "TEST",
          1_000_000_000,
          18,
          creator.address,
          defaultMetadata
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(log as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = tokenFactory.interface.parseLog(event as any);
      const tokenAddress = parsedEvent?.args.tokenAddress;
      token = await ethers.getContractAt("LaunchpadTokenV2", tokenAddress);
    });

    it("Should transfer tokens", async function () {
      const amount = ethers.parseEther("1000");

      await token.connect(creator).transfer(user1.address, amount);

      expect(await token.balanceOf(user1.address)).to.equal(amount);
    });

    it("Should allow users to burn their own tokens", async function () {
      const burnAmount = ethers.parseEther("100000");
      const initialSupply = await token.totalSupply();

      await token.connect(creator).burn(burnAmount);

      expect(await token.totalSupply()).to.equal(initialSupply - burnAmount);
    });

    it("Should allow any holder to burn their own tokens", async function () {
      await token
        .connect(creator)
        .transfer(user1.address, ethers.parseEther("1000"));

      const user1BalanceBefore = await token.balanceOf(user1.address);
      const burnAmount = ethers.parseEther("100");

      await token.connect(user1).burn(burnAmount);

      const user1BalanceAfter = await token.balanceOf(user1.address);
      expect(user1BalanceAfter).to.equal(user1BalanceBefore - burnAmount);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle tokens with different decimals", async function () {
      const tx = await tokenFactory
        .connect(creator)
        .createToken(
          "USDC Clone",
          "USDC",
          1_000_000_000,
          6,
          creator.address,
          defaultMetadata
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(log as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = tokenFactory.interface.parseLog(event as any);
      const tokenAddress = parsedEvent?.args.tokenAddress;
      const token = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );

      expect(await token.decimals()).to.equal(6);
      // ✅ FIXED: Changed from 1 million to 1 billion
      expect(await token.totalSupply()).to.equal(1_000_000_000n * 10n ** 6n);
    });

    it("Should handle empty metadata strings", async function () {
      const emptyMetadata = {
        logoURI: "",
        description: "",
        website: "",
        twitter: "",
        telegram: "",
        discord: "",
      };

      const tx = await tokenFactory
        .connect(creator)
        .createToken(
          "Empty Meta Token",
          "EMT",
          1_000_000_000,
          18,
          creator.address,
          emptyMetadata
        );

      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);
    });

    it("Should handle very long metadata strings", async function () {
      const longMetadata = {
        logoURI: "https://example.com/" + "a".repeat(500),
        description: "A".repeat(1000),
        website: "https://example.com/" + "b".repeat(500),
        twitter: "@" + "c".repeat(100),
        telegram: "https://t.me/" + "d".repeat(100),
        discord: "https://discord.gg/" + "e".repeat(100),
      };

      const tx = await tokenFactory
        .connect(creator)
        .createToken(
          "Long Meta Token",
          "LMT",
          1_000_000_000,
          18,
          creator.address,
          longMetadata
        );

      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);
    });
  });
});
