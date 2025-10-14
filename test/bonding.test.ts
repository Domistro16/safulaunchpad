import { expect } from "chai";
import hre from "hardhat";
import {
  BondingCurveDEX,
  TokenFactoryV2,
  LaunchpadTokenV2,
  MockPriceOracle,
} from "../types/ethers-contracts/index.js";
import { network } from "hardhat";

const { ethers } = await network.connect();

describe("BondingCurveDEX", function () {
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

  const INITIAL_LIQUIDITY_BNB = ethers.parseEther("50");
  const INITIAL_LIQUIDITY_TOKENS = ethers.parseEther("700000");
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

    // Deploy MockPriceOracle
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    priceOracle = await MockPriceOracle.deploy();
    await priceOracle.waitForDeployment();
    await priceOracle.setBNBPrice(BNB_PRICE_USD);

    // Deploy TokenFactory
    const TokenFactoryV2 = await ethers.getContractFactory("TokenFactoryV2");
    tokenFactory = await TokenFactoryV2.deploy();
    await tokenFactory.waitForDeployment();

    // Deploy BondingCurveDEX with oracle
    const BondingCurveDEX = await ethers.getContractFactory("BondingCurveDEX");
    bondingCurveDEX = await BondingCurveDEX.deploy(
      platformFee.address,
      academyFee.address,
      infoFiFee.address,
      await priceOracle.getAddress()
    );
    await bondingCurveDEX.waitForDeployment();

    // Create a test token
    const tx = await tokenFactory.createToken(
      "Test Token",
      "TEST",
      1_000_000,
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

    // Approve and create pool
    await token.approve(
      await bondingCurveDEX.getAddress(),
      INITIAL_LIQUIDITY_TOKENS
    );

    await bondingCurveDEX.createPool(
      await token.getAddress(),
      INITIAL_LIQUIDITY_TOKENS,
      { value: INITIAL_LIQUIDITY_BNB }
    );
  });

  // Keep ALL existing tests from document 7 unchanged
  describe("Pool Creation - Option 1 (PROJECT_RAISE)", function () {
    it("Should create a pool with correct reserves", async function () {
      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfo.bnbReserve).to.equal(INITIAL_LIQUIDITY_BNB);
      expect(poolInfo.tokenReserve).to.equal(INITIAL_LIQUIDITY_TOKENS);
      expect(poolInfo.graduated).to.be.false;
    });

    it("Should set graduation market cap in BNB based on USD threshold", async function () {
      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      // $500k / $580 = ~862 BNB
      // Market cap should be compared against USD value
      expect(poolInfo.marketCapUSD).to.be.gt(0);
    });

    it("Should reject pool creation for existing token", async function () {
      await expect(
        bondingCurveDEX.createPool(
          await token.getAddress(),
          INITIAL_LIQUIDITY_TOKENS,
          { value: INITIAL_LIQUIDITY_BNB }
        )
      ).to.be.revertedWith("Pool already exists");
    });

    it("Should track active tokens", async function () {
      const activeTokens = await bondingCurveDEX.getActiveTokens();
      expect(activeTokens.length).to.equal(1);
      expect(activeTokens[0]).to.equal(await token.getAddress());
    });

    it("Should calculate initial market cap correctly in USD with honest reserves", async function () {
      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      // With honest reserves (no inflation):
      // BNB Reserve = 50 BNB
      // Market cap in BNB = (50 * 1M) / 700k = ~71.43 BNB
      // Market cap in USD = 71.43 * $580 = ~$41,429
      expect(poolInfo.marketCapUSD).to.be.closeTo(
        ethers.parseEther("41428"),
        ethers.parseEther("100")
      );
    });
  });

  // NEW: Option 2 Pool Creation Tests
  describe("Pool Creation - Option 2 (INSTANT_LAUNCH)", function () {
    let instantToken: LaunchpadTokenV2;

    beforeEach(async function () {
      const tx = await tokenFactory.createToken(
        "Instant Token",
        "INST",
        1_000_000,
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
      instantToken = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );

      await instantToken.approve(
        await bondingCurveDEX.getAddress(),
        INITIAL_LIQUIDITY_TOKENS
      );
    });

    it("Should create instant launch pool with correct type", async function () {
      await bondingCurveDEX.createInstantLaunchPool(
        await instantToken.getAddress(),
        INITIAL_LIQUIDITY_TOKENS,
        trader1.address, // creator
        { value: INITIAL_LIQUIDITY_BNB }
      );

      const pool = await bondingCurveDEX.pools(await instantToken.getAddress());
      expect(pool.launchType).to.equal(1); // INSTANT_LAUNCH
      expect(pool.creator).to.equal(trader1.address);
    });

    it("Should initialize creator fees tracking for instant launch", async function () {
      await bondingCurveDEX.createInstantLaunchPool(
        await instantToken.getAddress(),
        INITIAL_LIQUIDITY_TOKENS,
        trader1.address,
        { value: INITIAL_LIQUIDITY_BNB }
      );

      const feeInfo = await bondingCurveDEX.getCreatorFeeInfo(
        await instantToken.getAddress()
      );

      expect(feeInfo.accumulatedFees).to.equal(0);
      expect(feeInfo.totalPurchaseVolume).to.equal(0);
    });

    it("Should graduate based on purchase volume, not market cap", async function () {
      await bondingCurveDEX.createInstantLaunchPool(
        await instantToken.getAddress(),
        INITIAL_LIQUIDITY_TOKENS,
        trader1.address,
        { value: INITIAL_LIQUIDITY_BNB }
      );

      // Buy 15 BNB worth to trigger graduation
      await bondingCurveDEX
        .connect(trader2)
        .buyTokens(await instantToken.getAddress(), 0, {
          value: ethers.parseEther("15"),
        });

      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await instantToken.getAddress()
      );
      expect(poolInfo.graduated).to.be.true;

      // Pool should stay active even after graduation
      const pool = await bondingCurveDEX.pools(await instantToken.getAddress());
      expect(pool.active).to.be.true;
    });
  });

  // Keep ALL existing buying tests from document 7
  describe("Buying Tokens - Option 1", function () {
    it("Should buy tokens from bonding curve", async function () {
      const buyAmount = ethers.parseEther("1");

      const balanceBefore = await token.balanceOf(trader1.address);

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, { value: buyAmount });

      const balanceAfter = await token.balanceOf(trader1.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should get accurate buy quote", async function () {
      const buyAmount = ethers.parseEther("1");

      const quote = await bondingCurveDEX.getBuyQuote(
        await token.getAddress(),
        buyAmount
      );

      expect(quote.tokensOut).to.be.gt(0);
      expect(quote.pricePerToken).to.be.gt(0);
    });

    it("Should respect slippage protection", async function () {
      const buyAmount = ethers.parseEther("1");
      const quote = await bondingCurveDEX.getBuyQuote(
        await token.getAddress(),
        buyAmount
      );

      // Set minimum too high
      const minTokens = quote.tokensOut * 2n;

      await expect(
        bondingCurveDEX
          .connect(trader1)
          .buyTokens(await token.getAddress(), minTokens, { value: buyAmount })
      ).to.be.revertedWith("Slippage too high");
    });

    it("Should distribute fees correctly on buy", async function () {
      const buyAmount = ethers.parseEther("10");

      const platformBalanceBefore = await ethers.provider.getBalance(
        platformFee.address
      );
      const academyBalanceBefore = await ethers.provider.getBalance(
        academyFee.address
      );
      const infoFiBalanceBefore = await ethers.provider.getBalance(
        infoFiFee.address
      );

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, { value: buyAmount });

      const platformBalanceAfter = await ethers.provider.getBalance(
        platformFee.address
      );
      const academyBalanceAfter = await ethers.provider.getBalance(
        academyFee.address
      );
      const infoFiBalanceAfter = await ethers.provider.getBalance(
        infoFiFee.address
      );

      // All fee addresses should have received funds
      expect(platformBalanceAfter).to.be.gt(platformBalanceBefore);
      expect(academyBalanceAfter).to.be.gt(academyBalanceBefore);
      expect(infoFiBalanceAfter).to.be.gt(infoFiBalanceBefore);

      // Verify fee distribution ratios (approximately)
      const platformFees = platformBalanceAfter - platformBalanceBefore;
      const academyFees = academyBalanceAfter - academyBalanceBefore;
      const infoFiFees = infoFiBalanceAfter - infoFiBalanceBefore;

      // 0.1%, 0.3%, 0.6% respectively
      expect(academyFees).to.be.closeTo(
        platformFees * 3n,
        ethers.parseEther("0.001")
      );
      expect(infoFiFees).to.be.closeTo(
        platformFees * 6n,
        ethers.parseEther("0.001")
      );
    });

    it("Should update reserves and market cap after buy", async function () {
      const buyAmount = ethers.parseEther("1");

      const poolInfoBefore = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, { value: buyAmount });

      const poolInfoAfter = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfoAfter.bnbReserve).to.be.gt(poolInfoBefore.bnbReserve);
      expect(poolInfoAfter.tokenReserve).to.be.lt(poolInfoBefore.tokenReserve);
      expect(poolInfoAfter.marketCapBNB).to.be.gt(poolInfoBefore.marketCapBNB);
      expect(poolInfoAfter.marketCapUSD).to.be.gt(poolInfoBefore.marketCapUSD);
    });

    it("Should increase price with each buy", async function () {
      const buyAmount = ethers.parseEther("1");

      const quote1 = await bondingCurveDEX.getBuyQuote(
        await token.getAddress(),
        buyAmount
      );

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, { value: buyAmount });

      const quote2 = await bondingCurveDEX.getBuyQuote(
        await token.getAddress(),
        buyAmount
      );

      // Price should increase after buy
      expect(quote2.pricePerToken).to.be.gt(quote1.pricePerToken);
    });

    it("Should emit TokensBought event", async function () {
      const buyAmount = ethers.parseEther("1");

      await expect(
        bondingCurveDEX
          .connect(trader1)
          .buyTokens(await token.getAddress(), 0, { value: buyAmount })
      ).to.emit(bondingCurveDEX, "TokensBought");
    });

    it("Should update graduation progress based on USD market cap", async function () {
      const buyAmount = ethers.parseEther("100");

      const poolInfoBefore = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, { value: buyAmount });

      const poolInfoAfter = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      // Progress should increase
      expect(poolInfoAfter.graduationProgress).to.be.gt(
        poolInfoBefore.graduationProgress
      );

      // Progress = (marketCapUSD * 100) / $500k
      const expectedProgress =
        (poolInfoAfter.marketCapUSD * 100n) / ethers.parseEther("500000");
      expect(poolInfoAfter.graduationProgress).to.equal(expectedProgress);
    });
  });

  // NEW: Option 2 Buying Tests
  describe("Buying Tokens - Option 2", function () {
    let instantToken: LaunchpadTokenV2;

    beforeEach(async function () {
      const tx = await tokenFactory.createToken(
        "Instant Token",
        "INST",
        1_000_000,
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
      instantToken = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );

      await instantToken.approve(
        await bondingCurveDEX.getAddress(),
        INITIAL_LIQUIDITY_TOKENS
      );

      await bondingCurveDEX.createInstantLaunchPool(
        await instantToken.getAddress(),
        INITIAL_LIQUIDITY_TOKENS,
        trader1.address,
        { value: INITIAL_LIQUIDITY_BNB }
      );
    });

    it("Should buy tokens with 2% fee", async function () {
      const buyAmount = ethers.parseEther("1");

      await bondingCurveDEX
        .connect(trader2)
        .buyTokens(await instantToken.getAddress(), 0, { value: buyAmount });

      const balance = await instantToken.balanceOf(trader2.address);
      expect(balance).to.be.gt(0);
    });

    it("Should accumulate creator fees (1% of 2%)", async function () {
      const buyAmount = ethers.parseEther("10");

      await bondingCurveDEX
        .connect(trader2)
        .buyTokens(await instantToken.getAddress(), 0, { value: buyAmount });

      const feeInfo = await bondingCurveDEX.getCreatorFeeInfo(
        await instantToken.getAddress()
      );

      // 2% total fee, 50% goes to creator = 1%
      const expectedCreatorFee = (buyAmount * 10n) / 1000n; // 1%
      expect(feeInfo.accumulatedFees).to.be.closeTo(
        expectedCreatorFee,
        ethers.parseEther("0.01")
      );
    });

    it("Should track purchase volume for graduation", async function () {
      const buyAmount = ethers.parseEther("5");

      await bondingCurveDEX
        .connect(trader2)
        .buyTokens(await instantToken.getAddress(), 0, { value: buyAmount });

      const feeInfo = await bondingCurveDEX.getCreatorFeeInfo(
        await instantToken.getAddress()
      );

      expect(feeInfo.totalPurchaseVolume).to.equal(buyAmount);
    });

    it("Should graduate after 15 BNB in purchases", async function () {
      // Buy 15 BNB worth
      await bondingCurveDEX
        .connect(trader2)
        .buyTokens(await instantToken.getAddress(), 0, {
          value: ethers.parseEther("15"),
        });

      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await instantToken.getAddress()
      );

      expect(poolInfo.graduated).to.be.true;
      expect(poolInfo.graduationProgress).to.be.gte(100);
    });

    it("Should distribute fees correctly (0.1% platform, 1% creator, 0.9% InfoFi)", async function () {
      const buyAmount = ethers.parseEther("10");

      const platformBalanceBefore = await ethers.provider.getBalance(
        platformFee.address
      );
      const infoFiBalanceBefore = await ethers.provider.getBalance(
        infoFiFee.address
      );

      await bondingCurveDEX
        .connect(trader2)
        .buyTokens(await instantToken.getAddress(), 0, { value: buyAmount });

      const platformBalanceAfter = await ethers.provider.getBalance(
        platformFee.address
      );
      const infoFiBalanceAfter = await ethers.provider.getBalance(
        infoFiFee.address
      );

      const platformFees = platformBalanceAfter - platformBalanceBefore;
      const infoFiFees = infoFiBalanceAfter - infoFiBalanceBefore;

      // 0.1% and 0.9% (ratio 1:9)
      expect(infoFiFees).to.be.closeTo(
        platformFees * 9n,
        ethers.parseEther("0.01")
      );
    });
  });

  // NEW: Creator Fee Claiming Tests
  describe("Creator Fee Claiming - Option 2", function () {
    let instantToken: LaunchpadTokenV2;

    beforeEach(async function () {
      const tx = await tokenFactory.createToken(
        "Instant Token",
        "INST",
        1_000_000,
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
      instantToken = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );

      await instantToken.approve(
        await bondingCurveDEX.getAddress(),
        INITIAL_LIQUIDITY_TOKENS
      );

      await bondingCurveDEX.createInstantLaunchPool(
        await instantToken.getAddress(),
        INITIAL_LIQUIDITY_TOKENS,
        trader1.address,
        { value: INITIAL_LIQUIDITY_BNB }
      );

      // Graduate the pool
      await bondingCurveDEX
        .connect(trader2)
        .buyTokens(await instantToken.getAddress(), 0, {
          value: ethers.parseEther("15"),
      });
    });

    it("Should enforce 24-hour cooldown", async function () {
      await expect(
        bondingCurveDEX
          .connect(trader1)
          .claimCreatorFees(await instantToken.getAddress())
      ).to.be.revertedWith("Claim cooldown active");
    });

    it("Should allow creator to claim when conditions met", async function () {
      // Wait 24 hours
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine");

      const balanceBefore = await ethers.provider.getBalance(trader1.address);

      const tx = await bondingCurveDEX
        .connect(trader1)
        .claimCreatorFees(await instantToken.getAddress());

      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(trader1.address);

      expect(balanceAfter + gasUsed).to.be.gt(balanceBefore);
    });

    it("Should redirect to InfoFi when market cap drops for 7 days", async function () {
      // Sell to drop market cap
      const tokens = await instantToken.balanceOf(trader2.address);
      await instantToken
        .connect(trader2)
        .approve(await bondingCurveDEX.getAddress(), tokens);
      await bondingCurveDEX
        .connect(trader2)
        .sellTokens(await instantToken.getAddress(), tokens / 2n, 0);

      // Wait 7 days
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine");

      const infoFiBalanceBefore = await ethers.provider.getBalance(
        infoFiFee.address
      );

      await bondingCurveDEX
        .connect(trader1)
        .claimCreatorFees(await instantToken.getAddress());

      const infoFiBalanceAfter = await ethers.provider.getBalance(
        infoFiFee.address
      );

      expect(infoFiBalanceAfter).to.be.gt(infoFiBalanceBefore);
    });

    it("Should reject claim from non-creator", async function () {
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine");

      await expect(
        bondingCurveDEX
          .connect(trader2)
          .claimCreatorFees(await instantToken.getAddress())
      ).to.be.revertedWith("Not creator");
    });

    it("Should reject claim for Option 1 pools", async function () {
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine");

      await expect(
        bondingCurveDEX
          .connect(owner)
          .claimCreatorFees(await token.getAddress())
      ).to.be.revertedWith("Not instant launch");
    });
  });

  // Keep ALL existing selling tests from document 7 unchanged
  describe("Selling Tokens", function () {
    let tokensReceived: bigint;

    beforeEach(async function () {
      // Buy some tokens first
      const buyAmount = ethers.parseEther("10");
      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, { value: buyAmount });

      tokensReceived = await token.balanceOf(trader1.address);
    });

    it("Should sell tokens to bonding curve", async function () {
      const sellAmount = tokensReceived / 2n;

      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), sellAmount);

      const bnbBalanceBefore = await ethers.provider.getBalance(
        trader1.address
      );

      const tx = await bondingCurveDEX
        .connect(trader1)
        .sellTokens(await token.getAddress(), sellAmount, 0);

      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const bnbBalanceAfter = await ethers.provider.getBalance(trader1.address);
      const bnbReceived = bnbBalanceAfter - bnbBalanceBefore + gasUsed;

      expect(bnbReceived).to.be.gt(0);
    });

    it("Should get accurate sell quote", async function () {
      const sellAmount = tokensReceived / 2n;

      const quote = await bondingCurveDEX.getSellQuote(
        await token.getAddress(),
        sellAmount
      );

      expect(quote.bnbOut).to.be.gt(0);
      expect(quote.pricePerToken).to.be.gt(0);
    });

    it("Should respect slippage protection on sell", async function () {
      const sellAmount = tokensReceived / 2n;
      const quote = await bondingCurveDEX.getSellQuote(
        await token.getAddress(),
        sellAmount
      );

      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), sellAmount);

      // Set minimum too high
      const minBNB = quote.bnbOut * 2n;

      await expect(
        bondingCurveDEX
          .connect(trader1)
          .sellTokens(await token.getAddress(), sellAmount, minBNB)
      ).to.be.revertedWith("Slippage too high");
    });

    it("Should decrease price with each sell", async function () {
      const sellAmount = tokensReceived / 4n;

      const quote1 = await bondingCurveDEX.getSellQuote(
        await token.getAddress(),
        sellAmount
      );

      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), sellAmount);

      await bondingCurveDEX
        .connect(trader1)
        .sellTokens(await token.getAddress(), sellAmount, 0);

      const quote2 = await bondingCurveDEX.getSellQuote(
        await token.getAddress(),
        sellAmount
      );

      // Price should decrease after sell
      expect(quote2.pricePerToken).to.be.lt(quote1.pricePerToken);
    });

    it("Should emit TokensSold event", async function () {
      const sellAmount = tokensReceived / 2n;

      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), sellAmount);

      await expect(
        bondingCurveDEX
          .connect(trader1)
          .sellTokens(await token.getAddress(), sellAmount, 0)
      ).to.emit(bondingCurveDEX, "TokensSold");
    });

    it("Should decrease market cap in USD after sell", async function () {
      const sellAmount = tokensReceived / 2n;

      const poolInfoBefore = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), sellAmount);

      await bondingCurveDEX
        .connect(trader1)
        .sellTokens(await token.getAddress(), sellAmount, 0);

      const poolInfoAfter = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfoAfter.marketCapUSD).to.be.lt(poolInfoBefore.marketCapUSD);
    });
  });

  // Keep ALL remaining sections from document 7 exactly as they are
  describe("Market Cap & Graduation", function () {
    it("Should track market cap accurately in both BNB and USD", async function () {
      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      expect(poolInfo.marketCapBNB).to.be.gt(0);
      expect(poolInfo.marketCapUSD).to.be.gt(0);

      // USD value should match BNB * price
      const expectedUSD =
        (poolInfo.marketCapBNB * BNB_PRICE_USD) / ethers.parseEther("1");
      expect(poolInfo.marketCapUSD).to.be.closeTo(
        expectedUSD,
        ethers.parseEther("0.001")
      );
    });

    it("Should show graduation progress based on USD", async function () {
      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );
      expect(poolInfo.graduationProgress).to.be.gte(0);
      expect(poolInfo.graduationProgress).to.be.lte(100);

      // Progress = (marketCapUSD * 100) / $500k
      const expectedProgress =
        (poolInfo.marketCapUSD * 100n) / ethers.parseEther("500000");
      expect(poolInfo.graduationProgress).to.equal(expectedProgress);
    });

    it("Should automatically graduate when USD market cap reaches $500k", async function () {
      // Buy in chunks to avoid gas issues
      for (let i = 0; i < 10; i++) {
        try {
          await bondingCurveDEX
            .connect(trader1)
            .buyTokens(await token.getAddress(), 0, {
              value: ethers.parseEther("100"),
            });
        } catch (e) {
          break;
        }
      }

      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      if (poolInfo.marketCapUSD >= ethers.parseEther("500000")) {
        expect(poolInfo.graduated).to.be.true;
      }
    });

    it("Should manually graduate pool (owner function)", async function () {
      await bondingCurveDEX.graduatePool(await token.getAddress());

      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );
      expect(poolInfo.graduated).to.be.true;
    });

    it("Should deactivate pool after graduation", async function () {
      await bondingCurveDEX.graduatePool(await token.getAddress());

      const poolInfo = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );
      expect(poolInfo.graduated).to.be.true;

      // Should reject further trades
      await expect(
        bondingCurveDEX
          .connect(trader1)
          .buyTokens(await token.getAddress(), 0, {
            value: ethers.parseEther("1"),
          })
      ).to.be.revertedWith("Pool has graduated");
    });

    it("Should reject sells after graduation", async function () {
      // Buy tokens first
      await bondingCurveDEX
        .connect(trader1)
        .buyTokens(await token.getAddress(), 0, {
          value: ethers.parseEther("5"),
        });

      const tokens = await token.balanceOf(trader1.address);

      // Graduate
      await bondingCurveDEX.graduatePool(await token.getAddress());

      // Try to sell
      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), tokens);

      await expect(
        bondingCurveDEX
          .connect(trader1)
          .sellTokens(await token.getAddress(), tokens, 0)
      ).to.be.revertedWith("Pool has graduated");
    });

    it("Should emit PoolGraduated event", async function () {
      await expect(bondingCurveDEX.graduatePool(await token.getAddress()))
        .to.emit(bondingCurveDEX, "PoolGraduated")
        .withArgs(
          await token.getAddress(),
          await bondingCurveDEX
            .getPoolInfo(await token.getAddress())
            .then((info) => info.marketCapBNB)
        );
    });
  });

  describe("Price Oracle Integration", function () {
    it("Should adapt graduation threshold to BNB price changes", async function () {
      const TokenFactoryV2 = await ethers.getContractFactory("TokenFactoryV2");
      const factory2 = await TokenFactoryV2.deploy();
      await factory2.waitForDeployment();

      const tx = await factory2.createToken(
        "Token2",
        "TK2",
        1_000_000,
        18,
        owner.address,
        defaultMetadata
      );

      const receipt = await tx.wait();
      const event = receipt?.logs?.find((log: any) => {
        try {
          return (
            factory2.interface.parseLog(
              log as unknown as Parameters<
                typeof factory2.interface.parseLog
              >[0]
            )?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = factory2.interface.parseLog(event as any);
      const token2Address = parsedEvent?.args.tokenAddress;
      const token2 = await ethers.getContractAt(
        "LaunchpadTokenV2",
        token2Address
      );

      await token2.approve(
        await bondingCurveDEX.getAddress(),
        INITIAL_LIQUIDITY_TOKENS
      );

      await bondingCurveDEX.createPool(
        await token2.getAddress(),
        INITIAL_LIQUIDITY_TOKENS,
        { value: INITIAL_LIQUIDITY_BNB }
      );

      const poolInfo1 = await bondingCurveDEX.getPoolInfo(token2Address);

      // Change BNB price to $1000
      await priceOracle.setBNBPrice(ethers.parseEther("1000"));

      const poolInfo2 = await bondingCurveDEX.getPoolInfo(token2Address);

      // Market cap in BNB stays same
      expect(poolInfo2.marketCapBNB).to.equal(poolInfo1.marketCapBNB);

      // Market cap in USD should increase (~72% increase: 1000/580)
      const expectedUSD =
        (poolInfo1.marketCapBNB * ethers.parseEther("1000")) /
        ethers.parseEther("1");
      expect(poolInfo2.marketCapUSD).to.be.closeTo(
        expectedUSD,
        ethers.parseEther("10")
      );
    });

    it("Should calculate different graduation thresholds for different BNB prices", async function () {
      // Change price to $1000
      await priceOracle.setBNBPrice(ethers.parseEther("1000"));

      const TokenFactoryV2 = await ethers.getContractFactory("TokenFactoryV2");
      const factory2 = await TokenFactoryV2.deploy();
      await factory2.waitForDeployment();

      const tx = await factory2.createToken(
        "TokenHighPrice",
        "TKH",
        1_000_000,
        18,
        owner.address,
        defaultMetadata
      );

      const receipt = await tx.wait();
      const event = receipt?.logs?.find((log: any) => {
        try {
          return (
            factory2.interface.parseLog(
              log as unknown as Parameters<
                typeof factory2.interface.parseLog
              >[0]
            )?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = factory2.interface.parseLog(event as any);
      const tokenHighAddress = parsedEvent?.args.tokenAddress;
      const tokenHigh = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenHighAddress
      );

      await tokenHigh.approve(
        await bondingCurveDEX.getAddress(),
        INITIAL_LIQUIDITY_TOKENS
      );

      await bondingCurveDEX.createPool(
        await tokenHigh.getAddress(),
        INITIAL_LIQUIDITY_TOKENS,
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

      // Change price to $700
      await priceOracle.setBNBPrice(ethers.parseEther("700"));

      await bondingCurveDEX
        .connect(trader2)
        .buyTokens(await token.getAddress(), 0, {
          value: ethers.parseEther("10"),
        });

      const poolInfo2 = await bondingCurveDEX.getPoolInfo(
        await token.getAddress()
      );

      // Market cap in USD should reflect new price
      expect(poolInfo2.marketCapUSD).to.be.gt(poolInfo1.marketCapUSD);
    });
  });

  describe("Price Impact", function () {
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

      // Average price for large buy should be higher due to price impact
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

  describe("Multiple Traders", function () {
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

      // Trader1 should have more tokens (bought at lower price)
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
        "OwnableUnauthorizedAccount"
      );
    });

    it("Should allow owner to manually graduate pool", async function () {
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
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Edge Cases", function () {
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
      ).to.not.be.revert(ethers);
    });
  });
});
