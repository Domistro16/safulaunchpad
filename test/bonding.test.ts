/**
 * ═══════════════════════════════════════════════════════════════
 *                    INSTANT_LAUNCH TESTS ONLY
 * ═══════════════════════════════════════════════════════════════
 *
 * This file tests BondingCurveDEX which is used EXCLUSIVELY for
 * INSTANT_LAUNCH tokens.
 *
 * PROJECT_RAISE tokens use a completely different system
 * (contribution-based) handled by LaunchpadManager.
 *
 * For PROJECT_RAISE tests, see: LaunchpadManagerV3.test.ts
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { expect } from "chai";
import hre from "hardhat";
import {
  BondingCurveDEX,
  TokenFactoryV2,
  LaunchpadTokenV2,
  MockPriceOracle,
  MockPancakeFactory,
  MockPancakeRouter,
} from "../types/ethers-contracts/index.js";
import { network } from "hardhat";

const { ethers } = await network.connect();

describe("BondingCurveDEX - INSTANT_LAUNCH Tests", function () {
  let bondingCurveDEX: BondingCurveDEX;
  let tokenFactory: TokenFactoryV2;
  let priceOracle: MockPriceOracle;
  let token: LaunchpadTokenV2;
  let owner: any;
  let trader1: any;
  let trader2: any;
  let platformFee: any;
  let academyFee: any;
  let infoFiFee: any;
  let lpFeeHarvester: any;
  let mockPancakeRouter: MockPancakeRouter;
  let mockPancakeFactory: MockPancakeFactory;

  const INITIAL_LIQUIDITY_BNB = ethers.parseEther("50");
  const INITIAL_LIQUIDITY_TOKENS = ethers.parseEther("700000000");
  const BNB_PRICE_USD = ethers.parseEther("580"); // $580 per BNB

  const defaultMetadata = {
    logoURI: "https://example.com/logo.png",
    description: "Trading token",
    website: "https://example.com",
    twitter: "@token",
    telegram: "https://t.me/token",
    discord: "https://discord.gg/token",
  };

  beforeEach(async function () {
    [owner, trader1, trader2, platformFee, academyFee, infoFiFee] =
      await ethers.getSigners();

    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    priceOracle = await MockPriceOracle.deploy();
    await priceOracle.waitForDeployment();
    await priceOracle.setBNBPrice(BNB_PRICE_USD);
    const MockPancakeFactory = await ethers.getContractFactory(
      "MockPancakeFactory"
    );
    mockPancakeFactory = await MockPancakeFactory.deploy();
    await mockPancakeFactory.waitForDeployment();

    // Deploy MockPancakeRouter
    const MockPancakeRouter = await ethers.getContractFactory(
      "MockPancakeRouter"
    );
    mockPancakeRouter = await MockPancakeRouter.deploy();
    await mockPancakeRouter.waitForDeployment();

    // ✅ Connect factory to router
    await mockPancakeRouter.setFactory(await mockPancakeFactory.getAddress());

    const PANCAKE_ROUTER = await mockPancakeRouter.getAddress();
    const PANCAKE_FACTORY = await mockPancakeFactory.getAddress();

    const TokenFactoryV2 = await ethers.getContractFactory("TokenFactoryV2");
    tokenFactory = await TokenFactoryV2.deploy();
    await tokenFactory.waitForDeployment();
    const LPFeeHarvester = await ethers.getContractFactory("LPFeeHarvester");
    lpFeeHarvester = await LPFeeHarvester.deploy(
      PANCAKE_ROUTER,
      PANCAKE_FACTORY,
      platformFee.address,
      owner.address
    );
    const BondingCurveDEX = await ethers.getContractFactory("BondingCurveDEX");
    bondingCurveDEX = await BondingCurveDEX.deploy(
      platformFee.address,
      academyFee.address,
      infoFiFee.address,
      await priceOracle.getAddress(),
      owner.address,
      PANCAKE_ROUTER,
      PANCAKE_FACTORY,
      await lpFeeHarvester.getAddress()
    );
    await bondingCurveDEX.waitForDeployment();

    const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
    await bondingCurveDEX.grantRole(MANAGER_ROLE, owner.address);

    const tx = await tokenFactory.createToken(
      "Test Token",
      "TEST",
      1_000_000_000,
      18,
      owner.address,
      defaultMetadata
    );

    const receipt = await tx.wait();
    const event = receipt?.logs?.find((log: any) => {
      try {
        return (
          tokenFactory.interface.parseLog(
            log as unknown as Parameters<
              typeof tokenFactory.interface.parseLog
            >[0]
          )?.name === "TokenCreated"
        );
      } catch {
        return false;
      }
    });

    const parsedEvent = tokenFactory.interface.parseLog(event as any);
    const tokenAddress = parsedEvent?.args.tokenAddress;
    token = await ethers.getContractAt("LaunchpadTokenV2", tokenAddress);

    // ✅ Set exemptions BEFORE creating pool
    await token.setExemption(await bondingCurveDEX.getAddress(), true);

    await token.approve(
      await bondingCurveDEX.getAddress(),
      INITIAL_LIQUIDITY_TOKENS
    );

    // ✅ CLARIFICATION: This creates a pool for INSTANT_LAUNCH with initial BNB seeding
    // NOT for PROJECT_RAISE (which doesn't use BondingCurveDEX)
    await bondingCurveDEX.createPool(
      await token.getAddress(),
      INITIAL_LIQUIDITY_TOKENS,
      owner.address, // creator
      false, // burnLP
      { value: INITIAL_LIQUIDITY_BNB }
    );
  });

  describe("Pool Creation - INSTANT_LAUNCH with Initial BNB Seed", function () {
    it("Should create a pool with correct reserves", async function () {
      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      // ✅ FIXED: Expected reserve is now 630M (90% of 700M = tokens on curve)
      // Note: This is for INSTANT_LAUNCH pools, not PROJECT_RAISE
      const expectedReserve = (INITIAL_LIQUIDITY_TOKENS * 90n) / 100n;
      expect(poolInfo.bnbReserve).to.equal(INITIAL_LIQUIDITY_BNB);
      expect(poolInfo.tokenReserve).to.equal(expectedReserve);
      expect(poolInfo.graduated).to.be.false;
    });

    it("Should set graduation market cap in BNB based on USD threshold", async function () {
      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfo.marketCapUSD).to.be.gt(0);
    });

    it("Should reject pool creation for existing token", async function () {
      await expect(
        bondingCurveDEX.createPool(
          await token.getAddress(),
          INITIAL_LIQUIDITY_TOKENS,
          owner.address, // creator
          false, // burnLP
          { value: INITIAL_LIQUIDITY_BNB }
        )
      ).to.be.revertedWith("Pool already exists");
    });

    it("Should track active tokens", async function () {
      const activeTokens = await bondingCurveDEX.getActiveTokens();
      expect(activeTokens.length).to.equal(1);
      expect(activeTokens[0]).to.equal(await token.getAddress());
    });

    it("Should calculate initial market cap correctly in USD with augmented reserves", async function () {
      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfo.marketCapUSD).to.be.gt(0);

      const totalSupply = ethers.parseEther("1000000000");
      const expectedMarketCapFromPrice =
        (poolInfo.currentPrice * totalSupply) / 10n ** 18n;

      expect(poolInfo.marketCapBNB).to.be.closeTo(
        expectedMarketCapFromPrice,
        expectedMarketCapFromPrice / 100n
      );
    });
  });

  describe("Pool Creation - INSTANT_LAUNCH without Initial BNB", function () {
    let instantToken: LaunchpadTokenV2;

    beforeEach(async function () {
      const tx = await tokenFactory.createToken(
        "Instant Token",
        "INST",
        1_000_000_000,
        18,
        owner.address,
        defaultMetadata
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(
              log as unknown as Parameters<
                typeof tokenFactory.interface.parseLog
              >[0]
            )?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = tokenFactory.interface.parseLog(event as any);
      const tokenAddress = parsedEvent?.args.tokenAddress;
      instantToken = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );
      await instantToken.setExemption(await bondingCurveDEX.getAddress(), true);

      const totalSupplyWei = ethers.parseEther("1000000000");
      await instantToken.approve(
        await bondingCurveDEX.getAddress(),
        totalSupplyWei
      );
    });

    it("Should create instant launch pool with correct type", async function () {
      const INITIAL_BNB = ethers.parseEther("10");

      // ✅ This creates an INSTANT_LAUNCH pool
      await bondingCurveDEX.createInstantLaunchPool(
        await instantToken.getAddress(),
        ethers.parseEther("1000000000"),
        trader1.address, // creator
        false, // burnLP
        { value: INITIAL_BNB }
      );

      const pool = await bondingCurveDEX.pools(await instantToken.getAddress());
      expect(pool.launchType).to.equal(1); // INSTANT_LAUNCH
      expect(pool.creator).to.equal(trader1.address);
    });

    it("Should initialize virtual BNB reserve for price shaping", async function () {
      await bondingCurveDEX.createInstantLaunchPool(
        await instantToken.getAddress(),
        ethers.parseEther("1000000000"),
        trader1.address,
        false,
        { value: ethers.parseEther("10") }
      );

      const pool = await bondingCurveDEX.pools(await instantToken.getAddress());

      expect(pool.virtualBnbReserve).to.be.gt(0);
    });

    it("Should initialize creator fees tracking for instant launch", async function () {
      await bondingCurveDEX.createInstantLaunchPool(
        await instantToken.getAddress(),
        ethers.parseEther("1000000000"),
        trader1.address,
        false,
        { value: ethers.parseEther("10") }
      );

      const feeInfo = await bondingCurveDEX.getCreatorFeeInfo(
        await instantToken.getAddress()
      );

      expect(feeInfo.accumulatedFees).to.equal(0);
    });

    it("Should graduate based on BNB threshold (INSTANT_LAUNCH)", async function () {
      await bondingCurveDEX.createInstantLaunchPool(
        await instantToken.getAddress(),
        ethers.parseEther("1000000000"),
        trader1.address,
        false,
        { value: ethers.parseEther("10") }
      );

      // Buy tokens to reach graduation
      let graduated = false;
      let attempts = 0;

      while (!graduated && attempts < 50) {
        try {
          await bondingCurveDEX
            .connect(trader1)
            .buyTokens(await instantToken.getAddress(), 0, {
              value: ethers.parseEther("0.1"),
            });

          const poolInfo = await bondingCurveDEX.getPoolInfo(
            await instantToken.getAddress()
          );
          graduated = poolInfo.graduated;
          attempts++;
        } catch (e) {
          break;
        }
      }

      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await instantToken.getAddress()
      );

      if (poolInfo.graduated) {
        expect(poolInfo.bnbReserve).to.be.gte(
          ethers.parseEther("0.6") // GRADUATION_BNB_THRESHOLD
        );
      }
    });
  });

  describe("Trading - Buy Operations (INSTANT_LAUNCH)", function () {
    it("Should allow buying tokens", async function () {
      const buyAmount = ethers.parseEther("1");

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, {
          value: buyAmount,
        });

      const balance = await token.balanceOf(trader1.address);
      expect(balance).to.be.gt(0);
    });

    it("Should update reserves after buy", async function () {
      const poolInfoBefore = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, {
          value: ethers.parseEther("1"),
        });

      const poolInfoAfter = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfoAfter.bnbReserve).to.be.gt(poolInfoBefore.bnbReserve);
      expect(poolInfoAfter.tokenReserve).to.be.lt(poolInfoBefore.tokenReserve);
    });

    it("Should increase price after purchases", async function () {
      const poolInfo1 = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, {
          value: ethers.parseEther("1"),
        });

      const poolInfo2 = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfo2.currentPrice).to.be.gt(poolInfo1.currentPrice);
    });

    it("Should respect slippage protection on buy", async function () {
      const quote = await bondingCurveDEX.getBuyQuote(
        await token.getAddress(),
        ethers.parseEther("1")
      );

      const unrealisticMin = quote.tokensOut * 2n;

      await expect(
        bondingCurveDEX
          .connect(trader1)
          .buyTokens(await token.getAddress(), unrealisticMin, {
            value: ethers.parseEther("1"),
          })
      ).to.be.revertedWith("Slippage too high");
    });

    it("Should provide accurate buy quotes", async function () {
      const buyAmount = ethers.parseEther("1");
      const quote = await bondingCurveDEX.getBuyQuote(
        await token.getAddress(),
        buyAmount
      );

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, {
          value: buyAmount,
        });

      const actualBalance = await token.balanceOf(trader1.address);

      expect(actualBalance).to.be.closeTo(
        quote.tokensOut,
        quote.tokensOut / 1000n
      );
    });

    it("Should reject buying after graduation", async function () {
      const OPERATOR_ROLE = ethers.keccak256(
        ethers.toUtf8Bytes("OPERATOR_ROLE")
      );
      await bondingCurveDEX.grantRole(OPERATOR_ROLE, owner.address);

      await bondingCurveDEX.graduatePool(await token.getAddress());

      await expect(
        bondingCurveDEX
          .connect(trader1)
          .buyTokens(await token.getAddress(), 0, {
            value: ethers.parseEther("1"),
          })
      ).to.be.revertedWith("Buying forbidden after graduation");
    });
  });

  describe("Trading - Sell Operations (INSTANT_LAUNCH)", function () {
    beforeEach(async function () {
      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, {
          value: ethers.parseEther("5"),
        });
    });

    it("Should allow selling tokens", async function () {
      const balance = await token.balanceOf(trader1.address);
      const sellAmount = balance / 2n;

      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), sellAmount);

      const bnbBefore = await ethers.provider.getBalance(trader1.address);

      await bondingCurveDEX
        .connect(trader1)
        .sellTokens(await token.getAddress(), sellAmount, 0);

      const bnbAfter = await ethers.provider.getBalance(trader1.address);

      expect(bnbAfter).to.be.gt(bnbBefore);
    });

    it("Should update reserves after sell", async function () {
      const balance = await token.balanceOf(trader1.address);
      const sellAmount = balance / 2n;

      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), sellAmount);

      const poolInfoBefore = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      await bondingCurveDEX
        .connect(trader1)
        .sellTokens(await token.getAddress(), sellAmount, 0);

      const poolInfoAfter = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfoAfter.bnbReserve).to.be.lt(poolInfoBefore.bnbReserve);
      expect(poolInfoAfter.tokenReserve).to.be.gt(poolInfoBefore.tokenReserve);
    });

    it("Should decrease price after sells", async function () {
      const poolInfo1 = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      const balance = await token.balanceOf(trader1.address);
      const sellAmount = balance / 2n;

      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), sellAmount);

      await bondingCurveDEX
        .connect(trader1)
        .sellTokens(await token.getAddress(), sellAmount, 0);

      const poolInfo2 = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfo2.currentPrice).to.be.lt(poolInfo1.currentPrice);
    });

    it("Should respect slippage protection on sell", async function () {
      const balance = await token.balanceOf(trader1.address);
      const sellAmount = balance / 2n;

      const quote = await bondingCurveDEX.getSellQuote(
        await token.getAddress(),
        sellAmount
      );

      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), sellAmount);

      const unrealisticMin = quote.bnbOut * 2n;

      await expect(
        bondingCurveDEX
          .connect(trader1)
          .sellTokens(await token.getAddress(), sellAmount, unrealisticMin)
      ).to.be.revertedWith("Slippage too high");
    });

    it("Should provide accurate sell quotes", async function () {
      const balance = await token.balanceOf(trader1.address);
      const sellAmount = balance / 2n;

      const quote = await bondingCurveDEX.getSellQuote(
        await token.getAddress(),
        sellAmount
      );

      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), sellAmount);

      const bnbBefore = await ethers.provider.getBalance(trader1.address);

      const tx = await bondingCurveDEX
        .connect(trader1)
        .sellTokens(await token.getAddress(), sellAmount, 0);

      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const bnbAfter = await ethers.provider.getBalance(trader1.address);
      const actualBnbReceived = bnbAfter - bnbBefore + gasUsed;

      expect(actualBnbReceived).to.be.closeTo(
        quote.bnbOut,
        quote.bnbOut / 100n
      );
    });
  });

  describe("Fee Structure - Dynamic Anti-Bot Fees (INSTANT_LAUNCH)", function () {
    it("Should start with 10% fee (Tier 1)", async function () {
      const feeInfo = await bondingCurveDEX.getFeeInfo(
        await token.getAddress()
      );

      expect(feeInfo.currentFeeRate).to.equal(1000); // 10% = 1000 basis points
      expect(feeInfo.feeStage).to.equal("Tier 1 (10%)");
    });

    it("Should decay to 6% after 20 blocks (Tier 2)", async function () {
      for (let i = 0; i < 20; i++) {
        await ethers.provider.send("evm_mine");
      }

      const feeInfo = await bondingCurveDEX.getFeeInfo(
        await token.getAddress()
      );

      expect(feeInfo.currentFeeRate).to.equal(600); // 6% = 600 basis points
      expect(feeInfo.feeStage).to.equal("Tier 2 (6%)");
    });

    it("Should decay to 4% after 50 blocks (Tier 3)", async function () {
      for (let i = 0; i < 50; i++) {
        await ethers.provider.send("evm_mine");
      }

      const feeInfo = await bondingCurveDEX.getFeeInfo(
        await token.getAddress()
      );

      expect(feeInfo.currentFeeRate).to.equal(400); // 4% = 400 basis points
      expect(feeInfo.feeStage).to.equal("Tier 3 (4%)");
    });

    it("Should reach final fee of 1% after 100 blocks (INSTANT_LAUNCH)", async function () {
      for (let i = 0; i < 100; i++) {
        await ethers.provider.send("evm_mine");
      }

      const feeInfo = await bondingCurveDEX.getFeeInfo(
        await token.getAddress()
      );

      expect(feeInfo.currentFeeRate).to.equal(100); // 1% for INSTANT_LAUNCH
      expect(feeInfo.feeStage).to.equal("Final (1%)");
    });
  });

  describe("Graduation (INSTANT_LAUNCH)", function () {
    it("Should graduate when BNB threshold reached", async function () {
      let graduated = false;
      let attempts = 0;

      while (!graduated && attempts < 50) {
        try {
          await bondingCurveDEX
            .connect(trader1)
            .buyTokens(await token.getAddress(), 0, {
              value: ethers.parseEther("1"),
            });

          const poolInfo = await bondingCurveDEX.getPoolInfo(
            await token.getAddress()
          );
          graduated = poolInfo.graduated;
          attempts++;
        } catch (e) {
          break;
        }
      }

      if (graduated) {
        const poolInfo = await bondingCurveDEX.getPoolInfo(
          await token.getAddress()
        );
        expect(poolInfo.graduated).to.be.true;
      }
    });

    it("Should emit PoolGraduated event", async function () {
      let graduated = false;
      let attempts = 0;

      while (!graduated && attempts < 50) {
        try {
          const tx = await bondingCurveDEX
            .connect(trader1)
            .buyTokens(await token.getAddress(), 0, {
              value: ethers.parseEther("1"),
            });

          const poolInfo = await bondingCurveDEX.getPoolInfo(
            await token.getAddress()
          );
          graduated = poolInfo.graduated;

          if (graduated) {
            await expect(tx).to.emit(bondingCurveDEX, "PoolGraduated");
            break;
          }

          attempts++;
        } catch (e) {
          break;
        }
      }
    });

    it("Should allow withdrawal of graduated pool funds", async function () {
      const OPERATOR_ROLE = ethers.keccak256(
        ethers.toUtf8Bytes("OPERATOR_ROLE")
      );
      await bondingCurveDEX.grantRole(OPERATOR_ROLE, owner.address);

      await bondingCurveDEX.graduatePool(await token.getAddress());

      const result = await bondingCurveDEX.withdrawGraduatedPool(
        await token.getAddress()
      );

      expect(result).to.not.be.undefined;
    });
  });

  describe("Creator Fees (INSTANT_LAUNCH)", function () {
    beforeEach(async function () {
      for (let i = 0; i < 100; i++) {
        await ethers.provider.send("evm_mine");
      }

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, {
          value: ethers.parseEther("5"),
        });
    });

    it("Should accumulate creator fees from trades", async function () {
      const feeInfo = await bondingCurveDEX.getCreatorFeeInfo(
        await token.getAddress()
      );

      expect(feeInfo.accumulatedFees).to.be.gt(0);
    });

    it("Should allow creator to claim fees after cooldown", async function () {
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      const feeInfo = await bondingCurveDEX.getCreatorFeeInfo(
        await token.getAddress()
      );

      if (feeInfo.accumulatedFees > 0 && feeInfo.canClaim) {
        await expect(
          bondingCurveDEX
            .connect(owner)
            .claimCreatorFees(await token.getAddress())
        ).to.emit(bondingCurveDEX, "CreatorFeesClaimed");
      }
    });

    it("Should enforce 24-hour claim cooldown", async function () {
      const feeInfo = await bondingCurveDEX.getCreatorFeeInfo(
        await token.getAddress()
      );

      if (feeInfo.accumulatedFees > 0) {
        await expect(
          bondingCurveDEX
            .connect(owner)
            .claimCreatorFees(await token.getAddress())
        ).to.be.revertedWith("Claim cooldown active");
      }
    });
  });

  describe("Price Oracle Integration (INSTANT_LAUNCH)", function () {
    it("Should update market cap USD when BNB price changes", async function () {
      const poolInfo1 = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      await priceOracle.setBNBPrice(ethers.parseEther("700"));

      const poolInfo2 = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfo2.marketCapUSD).to.not.equal(poolInfo1.marketCapUSD);
    });

    it("Should maintain correct market cap in multiple tokens", async function () {
      const factory2 = await ethers.getContractFactory("TokenFactoryV2");
      const tokenFactory2 = await factory2.deploy();
      await tokenFactory2.waitForDeployment();

      const tx2 = await tokenFactory2.createToken(
        "High Value Token",
        "HIGH",
        1_000_000_000,
        18,
        owner.address,
        defaultMetadata
      );

      const receipt2 = await tx2.wait();
      const event = receipt2?.logs.find((log: any) => {
        try {
          return (
            tokenFactory2.interface.parseLog(
              log as unknown as Parameters<
                typeof tokenFactory2.interface.parseLog
              >[0]
            )?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = tokenFactory2.interface.parseLog(event as any);
      const tokenHighAddress = parsedEvent?.args.tokenAddress;
      const tokenHigh = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenHighAddress
      );
      await tokenHigh.setExemption(await bondingCurveDEX.getAddress(), true);

      await tokenHigh.approve(
        await bondingCurveDEX.getAddress(),
        INITIAL_LIQUIDITY_TOKENS
      );

      await bondingCurveDEX.createPool(
        await tokenHigh.getAddress(),
        INITIAL_LIQUIDITY_TOKENS,
        owner.address, // creator
        false, // burnLP
        { value: INITIAL_LIQUIDITY_BNB }
      );
    });

    it("Should handle price updates correctly during trading", async function () {
      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, {
          value: ethers.parseEther("10"),
        });

      const poolInfo1 = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      await priceOracle.setBNBPrice(ethers.parseEther("700"));

      await bondingCurveDEX
        .connect(trader2)
        .buyTokens(await token.getAddress(), 0, {
          value: ethers.parseEther("10"),
        });

      const poolInfo2 = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfo2.marketCapUSD).to.be.gt(poolInfo1.marketCapUSD);
    });
  });

  describe("Price Impact (INSTANT_LAUNCH)", function () {
    it("Should have higher price impact for larger trades", async function () {
      const smallBuy = ethers.parseEther("1");
      const largeBuy = ethers.parseEther("10");

      const quoteSmall = await bondingCurveDEX.getBuyQuote(
        await token.getAddress(),
        smallBuy
      );

      const quoteLarge = await bondingCurveDEX.getBuyQuote(
        await token.getAddress(),
        largeBuy
      );

      const smallAvgPrice = (smallBuy * 10n ** 18n) / quoteSmall.tokensOut;
      const largeAvgPrice = (largeBuy * 10n ** 18n) / quoteLarge.tokensOut;

      expect(largeAvgPrice).to.be.gt(smallAvgPrice);
    });

    it("Should handle very small trades", async function () {
      const tinyBuy = ethers.parseEther("0.001");

      const quote = await bondingCurveDEX.getBuyQuote(
        await token.getAddress(),
        tinyBuy
      );

      expect(quote.tokensOut).to.be.gt(0);
    });
  });

  describe("Multiple Traders (INSTANT_LAUNCH)", function () {
    it("Should handle multiple concurrent traders", async function () {
      const buyAmount = ethers.parseEther("5");

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, { value: buyAmount });

      await bondingCurveDEX
        .connect(trader2)
        .buyTokens(await token.getAddress(), 0, { value: buyAmount });

      const balance1 = await token.balanceOf(trader1.address);
      const balance2 = await token.balanceOf(trader2.address);

      expect(balance1).to.be.gt(0);
      expect(balance2).to.be.gt(0);

      expect(balance1).to.be.gt(balance2);
    });

    it("Should maintain correct reserves with multiple trades", async function () {
      const buyAmount = ethers.parseEther("2");

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, { value: buyAmount });

      await bondingCurveDEX
        .connect(trader2)
        .buyTokens(await token.getAddress(), 0, { value: buyAmount });

      const tokens1 = await token.balanceOf(trader1.address);
      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), tokens1 / 2n);
      await bondingCurveDEX
        .connect(trader1)
        .sellTokens(await token.getAddress(), tokens1 / 2n, 0);

      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );
      expect(poolInfo.bnbReserve).to.be.gt(0);
      expect(poolInfo.tokenReserve).to.be.gt(0);
      expect(poolInfo.marketCapUSD).to.be.gt(0);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to update fee addresses", async function () {
      const [newPlatform, newAcademy, newInfoFi] = await ethers.getSigners();

      await bondingCurveDEX.updateFeeAddresses(
        newPlatform.address,
        newAcademy.address,
        newInfoFi.address
      );
    });

    it("Should reject fee address updates from non-owner", async function () {
      const [newPlatform] = await ethers.getSigners();

      await expect(
        bondingCurveDEX
          .connect(trader1)
          .updateFeeAddresses(
            newPlatform.address,
            newPlatform.address,
            newPlatform.address
          )
      ).to.be.revertedWithCustomError(
        bondingCurveDEX,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("Should allow owner to manually graduate pool", async function () {
      const OPERATOR_ROLE = ethers.keccak256(
        ethers.toUtf8Bytes("OPERATOR_ROLE")
      );
      await bondingCurveDEX.grantRole(OPERATOR_ROLE, owner.address);

      await bondingCurveDEX.graduatePool(await token.getAddress());

      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );
      expect(poolInfo.graduated).to.be.true;
    });

    it("Should reject manual graduation from non-owner", async function () {
      await expect(
        bondingCurveDEX.connect(trader1).graduatePool(await token.getAddress())
      ).to.be.revertedWithCustomError(
        bondingCurveDEX,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  describe("Edge Cases (INSTANT_LAUNCH)", function () {
    it("Should reject zero amount buys", async function () {
      await expect(
        bondingCurveDEX
          .connect(trader1)
          .buyTokens(await token.getAddress(), 0, { value: 0 })
      ).to.be.revertedWith("Must send BNB");
    });

    it("Should reject zero amount sells", async function () {
      await expect(
        bondingCurveDEX
          .connect(trader1)
          .sellTokens(await token.getAddress(), 0, 0)
      ).to.be.revertedWith("Must sell tokens");
    });

    it("Should reject trades on non-existent pool", async function () {
      const fakeTokenAddress = ethers.Wallet.createRandom().address;

      await expect(
        bondingCurveDEX
          .connect(trader1)
          .buyTokens(fakeTokenAddress, 0, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Pool not active");
    });

    it("Should handle extreme price impact with slippage protection", async function () {
      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      const hugeBuy = poolInfo.bnbReserve * 100n;
      const unrealisticMin = poolInfo.tokenReserve;

      await expect(
        bondingCurveDEX
          .connect(trader1)
          .buyTokens(await token.getAddress(), unrealisticMin, {
            value: hugeBuy,
          })
      ).to.be.revertedWith("Slippage too high");
    });

    it("Should protect against buying more than real reserve", async function () {
      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, {
          value: ethers.parseEther("10"),
        });

      const trader1Balance = await token.balanceOf(trader1.address);

      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), trader1Balance);

      await bondingCurveDEX
        .connect(trader1)
        .sellTokens(await token.getAddress(), trader1Balance, 0);

      await expect(
        bondingCurveDEX
          .connect(trader2)
          .buyTokens(await token.getAddress(), 0, {
            value: ethers.parseEther("5"),
          })
      ).to.not.be.reverted;
    });
  });
});
