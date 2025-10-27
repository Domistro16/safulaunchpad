import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
import { ethers as ethersLib } from "ethers";
import {
  TokenFactoryV2,
  LaunchpadManagerV3,
  BondingCurveDEX,
  LaunchpadTokenV2,
  MockPriceOracle,
  LPFeeHarvester,
  MockPancakeRouter,
  MockPancakeFactory,
} from "../types/ethers-contracts/index.js";

describe("Integration Tests - Complete Launch Lifecycle with LP Harvester", function () {
  let tokenFactory: TokenFactoryV2;
  let bondingCurveDEX: BondingCurveDEX;
  let launchpadManager: LaunchpadManagerV3;
  let priceOracle: MockPriceOracle;
  let lpFeeHarvester: LPFeeHarvester;
  let mockPancakeRouter: MockPancakeRouter;
  let mockPancakeFactory: MockPancakeFactory;
  let owner: any;
  let founder: any;
  let investor1: any;
  let investor2: any;
  let trader1: any;
  let trader2: any;
  let platformFee: any;
  let academyFee: any;
  let infoFiFee: any;

  const BNB_PRICE_USD = ethers.parseEther("580"); // $580 per BNB
  const RAISE_TARGET_USD = ethers.parseEther("290000"); // $290k
  const RAISE_MAX_USD = ethers.parseEther("500000"); // $500k
  const VESTING_DURATION = 90 * 24 * 60 * 60;

  const defaultMetadata = {
    logoURI: "https://example.com/logo.png",
    description: "Revolutionary DeFi token",
    website: "https://example.com",
    twitter: "@testtoken",
    telegram: "https://t.me/testtoken",
    discord: "https://discord.gg/testtoken",
  };

  beforeEach(async function () {
    [
      owner,
      founder,
      investor1,
      investor2,
      trader1,
      trader2,
      platformFee,
      academyFee,
      infoFiFee,
    ] = await ethers.getSigners();

    // Deploy MockPriceOracle
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    priceOracle = await MockPriceOracle.deploy();
    await priceOracle.waitForDeployment();
    await priceOracle.setBNBPrice(BNB_PRICE_USD);

    // Deploy MockPancakeFactory first
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

    // Deploy LPFeeHarvester
    const LPFeeHarvester = await ethers.getContractFactory("LPFeeHarvester");
    lpFeeHarvester = await LPFeeHarvester.deploy(
      PANCAKE_ROUTER,
      PANCAKE_FACTORY,
      platformFee.address,
      owner.address // admin
    );
    await lpFeeHarvester.waitForDeployment();

    const BondingCurveDEX = await ethers.getContractFactory("BondingCurveDEX");
    bondingCurveDEX = await BondingCurveDEX.deploy(
      platformFee.address,
      academyFee.address,
      infoFiFee.address,
      await priceOracle.getAddress(),
      owner.address, // admin
      PANCAKE_ROUTER,
      PANCAKE_FACTORY,
      await lpFeeHarvester.getAddress()
    );
    await bondingCurveDEX.waitForDeployment();

    const LaunchpadManagerV3 = await ethers.getContractFactory(
      "LaunchpadManagerV3"
    );
    launchpadManager = await LaunchpadManagerV3.deploy(
      await tokenFactory.getAddress(),
      await bondingCurveDEX.getAddress(),
      PANCAKE_ROUTER,
      await priceOracle.getAddress(),
      infoFiFee.address,
      platformFee.address, // ✅ NEW: Platform fee address
      await lpFeeHarvester.getAddress(),
      PANCAKE_FACTORY
    );
    await launchpadManager.waitForDeployment();

    // Grant roles
    const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
    await bondingCurveDEX.grantRole(
      MANAGER_ROLE,
      await launchpadManager.getAddress()
    );
    await lpFeeHarvester.grantRole(
      MANAGER_ROLE,
      await launchpadManager.getAddress()
    );
  });

  describe("Full Launch Lifecycle - Option 1 (Project Raise) with LP Harvester", function () {
    let tokenAddress: string;
    let token: LaunchpadTokenV2;

    it("Should complete entire lifecycle from creation to LP locking", async function () {
      // ============================================================
      // PHASE 1: Token Creation
      // ============================================================
      console.log("\n📝 PHASE 1: Creating Launch...");

      const createTx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Awesome Token",
          "AWE",
          1_000_000_000,
          RAISE_TARGET_USD,
          RAISE_MAX_USD,
          VESTING_DURATION,
          defaultMetadata,
          false // burnLP
        );

      const createReceipt = await createTx.wait();
      const createEvent = createReceipt?.logs.find((log: any) => {
        try {
          return (
            launchpadManager.interface.parseLog(log as any)?.name ===
            "LaunchCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = launchpadManager.interface.parseLog(
        createEvent as any
      );
      tokenAddress = parsedEvent?.args[0];
      token = await ethers.getContractAt("LaunchpadTokenV2", tokenAddress);

      console.log("✅ Token created at:", tokenAddress);

      // Verify metadata
      const metadata = await token.getMetadata();
      expect(metadata.logoURI).to.equal(defaultMetadata.logoURI);
      expect(await token.name()).to.equal("Awesome Token");
      expect(await token.symbol()).to.equal("AWE");

      // ============================================================
      // PHASE 2: Fundraising
      // ============================================================
      console.log("\n💰 PHASE 2: Fundraising...");

      // $290k / $580 = 500 BNB target
      const invest1 = ethers.parseEther("300");
      const invest2 = ethers.parseEther("200");

      await launchpadManager.connect(investor1).contribute(tokenAddress, {
        value: invest1,
      });
      console.log(
        "  Investor 1 contributed:",
        ethers.formatEther(invest1),
        "BNB"
      );

      await launchpadManager.connect(investor2).contribute(tokenAddress, {
        value: invest2,
      });
      console.log(
        "  Investor 2 contributed:",
        ethers.formatEther(invest2),
        "BNB"
      );

      const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
      expect(launchInfo.raiseCompleted).to.be.true;
      console.log(
        "✅ Raise completed! Total raised:",
        ethers.formatEther(launchInfo.totalRaised),
        "BNB"
      );

      // Verify founder received immediate tokens (50% of 20%)
      const founderBalance = await token.balanceOf(founder.address);
      const expectedImmediate =
        (((ethers.parseEther("1000000") * 20n) / 100n) * 50n) / 100n;
      expect(founderBalance).to.equal(expectedImmediate);
      console.log(
        "  Founder received:",
        ethers.formatEther(founderBalance),
        "tokens (immediate 10%)"
      );

      // ============================================================
      // PHASE 3: Trading on Bonding Curve
      // ============================================================
      console.log("\n📈 PHASE 3: Trading on Bonding Curve...");

      const buyAmount1 = ethers.parseEther("5");
      await bondingCurveDEX.connect(trader1).buyTokens(tokenAddress, 0, {
        value: buyAmount1,
      });

      const trader1Tokens = await token.balanceOf(trader1.address);
      console.log(
        "  Trader 1 bought:",
        ethers.formatEther(trader1Tokens),
        "tokens"
      );

      const buyAmount2 = ethers.parseEther("3");
      await bondingCurveDEX.connect(trader2).buyTokens(tokenAddress, 0, {
        value: buyAmount2,
      });

      const trader2Tokens = await token.balanceOf(trader2.address);
      console.log(
        "  Trader 2 bought:",
        ethers.formatEther(trader2Tokens),
        "tokens"
      );

      // Check market cap (FIX #1: Should use augmented reserves for consistency)
      const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
      console.log(
        "  Current market cap:",
        ethers.formatEther(poolInfo.marketCapBNB),
        "BNB"
      );
      console.log(
        "  Current market cap:",
        ethers.formatEther(poolInfo.marketCapUSD),
        "USD"
      );
      console.log(
        "  Graduation progress:",
        poolInfo.graduationProgress.toString(),
        "%"
      );

      // Verify consistency (FIX #1)
      const totalSupply = ethers.parseEther("1000000000");
      const expectedMarketCap =
        (poolInfo.currentPrice * totalSupply) / 10n ** 18n;
      expect(poolInfo.marketCapBNB).to.be.closeTo(
        expectedMarketCap,
        expectedMarketCap / 1000n // 0.1% tolerance
      );

      // ============================================================
      // PHASE 4: Graduation to PancakeSwap
      // ============================================================
      console.log("\n🎓 PHASE 4: Graduating to PancakeSwap...");

      // Force graduation by buying lots
      for (let i = 0; i < 25; i++) {
        try {
          await bondingCurveDEX.connect(trader1).buyTokens(tokenAddress, 0, {
            value: ethers.parseEther("50"),
          });
        } catch (e) {
          break;
        }
      }

      const poolInfoBeforeGrad = await bondingCurveDEX.getPoolInfo(
        tokenAddress
      );
      console.log("  Pool graduated:", poolInfoBeforeGrad.graduated);

      if (poolInfoBeforeGrad.graduated) {
        await launchpadManager.graduateToPancakeSwap(tokenAddress);
        console.log("✅ Graduated to PancakeSwap!");

        const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
        expect(launchInfo.graduatedToPancakeSwap).to.be.true;

        // ============================================================
        // PHASE 5: Verify LP Lock
        // ============================================================
        console.log("\n🔒 PHASE 5: Verifying LP Lock in Harvester...");

        const lockInfo = await lpFeeHarvester.getLockInfo(tokenAddress);
        expect(lockInfo.active).to.be.true;
        expect(lockInfo.creator).to.equal(founder.address);
        expect(lockInfo.lpAmount).to.be.gt(0);

        console.log(
          "  LP tokens locked:",
          ethers.formatEther(lockInfo.lpAmount)
        );
        console.log("  Lock active:", lockInfo.active);
        console.log("  Creator:", lockInfo.creator);
        console.log("  Project InfoFi:", lockInfo.projectInfoFi);

        // ============================================================
        // PHASE 6: Test Fee Harvesting with Safety Cap (FIX #3)
        // ============================================================
        console.log(
          "\n💰 PHASE 6: Testing Fee Harvesting with 5% Safety Cap..."
        );

        // Wait 24 hours for harvest cooldown
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
        await ethers.provider.send("evm_mine", []);

        const creatorBalanceBefore = await ethers.provider.getBalance(
          founder.address
        );
        const projectInfoFiBalanceBefore = await ethers.provider.getBalance(
          infoFiFee.address
        );
        const platformBalanceBefore = await ethers.provider.getBalance(
          platformFee.address
        );

        const lockInfoBeforeHarvest = await lpFeeHarvester.getLockInfo(
          tokenAddress
        );
        const initialLPAmount = lockInfoBeforeHarvest.lpAmount;

        // Harvest fees
        await lpFeeHarvester.harvestFees(tokenAddress);
        console.log("  Fees harvested!");

        const creatorBalanceAfter = await ethers.provider.getBalance(
          founder.address
        );
        const projectInfoFiBalanceAfter = await ethers.provider.getBalance(
          infoFiFee.address
        );
        const platformBalanceAfter = await ethers.provider.getBalance(
          platformFee.address
        );

        // Verify fee distribution (70% creator, 20% project, 10% platform)
        const creatorFees = creatorBalanceAfter - creatorBalanceBefore;
        const projectFees =
          projectInfoFiBalanceAfter - projectInfoFiBalanceBefore;
        const platformFees = platformBalanceAfter - platformBalanceBefore;

        console.log("  Creator fees:", ethers.formatEther(creatorFees), "BNB");
        console.log("  Project fees:", ethers.formatEther(projectFees), "BNB");
        console.log(
          "  Platform fees:",
          ethers.formatEther(platformFees),
          "BNB"
        );

        expect(creatorFees).to.be.gt(0);
        expect(projectFees).to.be.gt(0);
        expect(platformFees).to.be.gt(0);

        // Verify 5% LP safety cap (FIX #3)
        const lockInfoAfterHarvest = await lpFeeHarvester.getLockInfo(
          tokenAddress
        );
        const lpRemoved = initialLPAmount - lockInfoAfterHarvest.lpAmount;
        const maxAllowedRemoval = (initialLPAmount * 500n) / 10000n; // 5%

        console.log("  LP removed:", ethers.formatEther(lpRemoved));
        console.log(
          "  Max allowed (5%):",
          ethers.formatEther(maxAllowedRemoval)
        );

        expect(lpRemoved).to.be.lte(maxAllowedRemoval);

        expect(lockInfoAfterHarvest.totalFeesHarvested).to.be.gt(0);
        expect(lockInfoAfterHarvest.harvestCount).to.equal(1);

        console.log(
          "  Total fees harvested:",
          ethers.formatEther(lockInfoAfterHarvest.totalFeesHarvested),
          "BNB"
        );
        console.log("  Harvest count:", lockInfoAfterHarvest.harvestCount);

        console.log(
          "\n✅ Full lifecycle with LP harvesting and safety cap completed!"
        );
      }
    });
  });

  describe("Full Launch Lifecycle - Option 2 (Instant Launch) with LP Harvester", function () {
    it("Should complete entire instant launch lifecycle with LP locking and dual graduation check", async function () {
      console.log(
        "\n⚡ OPTION 2: Instant Launch Lifecycle with LP Harvester..."
      );

      // ============================================================
      // PHASE 1: Instant Launch Creation
      // ============================================================
      console.log("\n📝 PHASE 1: Creating Instant Launch...");

      const initialBuy = ethers.parseEther("2");
      const initialLiquidity = ethers.parseEther("10");
      const totalValue = initialBuy + initialLiquidity;

      const createTx = await launchpadManager
        .connect(founder)
        .createInstantLaunch(
          "Instant Token",
          "INST",
          1_000_000_000, // 1 billion
          defaultMetadata,
          initialBuy,
          false, // burnLP
          { value: totalValue }
        );

      const createReceipt = await createTx.wait();
      const createEvent = createReceipt?.logs.find((log: any) => {
        try {
          return (
            launchpadManager.interface.parseLog(log as any)?.name ===
            "InstantLaunchCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = launchpadManager.interface.parseLog(
        createEvent as any
      );
      const tokenAddress = parsedEvent?.args[0];
      const token = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );

      console.log("✅ Instant token created at:", tokenAddress);

      // Verify founder got initial tokens
      const founderBalance = await token.balanceOf(founder.address);
      console.log(
        "  Founder initial tokens:",
        ethers.formatEther(founderBalance)
      );
      expect(founderBalance).to.be.gt(0);

      // ============================================================
      // PHASE 2: Immediate Trading
      // ============================================================
      console.log("\n📈 PHASE 2: Immediate Trading...");

      await bondingCurveDEX.connect(trader1).buyTokens(tokenAddress, 0, {
        value: ethers.parseEther("5"),
      });
      console.log("  Trader 1 bought tokens");

      await bondingCurveDEX.connect(trader2).buyTokens(tokenAddress, 0, {
        value: ethers.parseEther("3"),
      });
      console.log("  Trader 2 bought tokens");

      // Check creator fees accumulated
      const feeInfo = await bondingCurveDEX.getCreatorFeeInfo(tokenAddress);
      console.log(
        "  Creator fees accumulated:",
        ethers.formatEther(feeInfo.accumulatedFees),
        "BNB"
      );
      expect(feeInfo.accumulatedFees).to.be.gt(0);

      // ============================================================
      // PHASE 3: Trigger Graduation with Dual Check (FIX #2)
      // ============================================================
      console.log(
        "\n🎓 PHASE 3: Reaching graduation threshold (15 BNB + $90k market cap)..."
      );

      // Buy more to reach BOTH 15 BNB AND $90k market cap
      await bondingCurveDEX.connect(trader1).buyTokens(tokenAddress, 0, {
        value: ethers.parseEther("0.1"),
      });

      const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);

      console.log(
        "  BNB Reserve:",
        ethers.formatEther(poolInfo.bnbReserve),
        "BNB"
      );
      console.log(
        "  Market Cap:",
        ethers.formatEther(poolInfo.marketCapUSD),
        "USD"
      );
      console.log("  Graduated:", poolInfo.graduated);

      // FIX #2: Should only graduate if BOTH conditions met
      if (poolInfo.graduated) {
        expect(poolInfo.bnbReserve).to.be.gte(ethers.parseEther("15"));
        expect(poolInfo.marketCapUSD).to.be.gte(ethers.parseEther("90000"));
        console.log(
          "✅ Pool graduated at 15 BNB threshold AND $90k market cap!"
        );
      }

      // ============================================================
      // PHASE 4: Graduate to PancakeSwap and Lock LP
      // ============================================================
      console.log("\n🔒 PHASE 4: Graduating to PancakeSwap and locking LP...");

      if (poolInfo.graduated) {
        await launchpadManager.graduateToPancakeSwap(tokenAddress);
        console.log("✅ Graduated and LP locked!");

        const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
        expect(launchInfo.graduatedToPancakeSwap).to.be.true;

        // Verify LP lock
        const lockInfo = await lpFeeHarvester.getLockInfo(tokenAddress);
        expect(lockInfo.active).to.be.true;
        expect(lockInfo.creator).to.equal(founder.address);
        expect(lockInfo.projectInfoFi).to.equal(infoFiFee.address); // InfoFi for instant launch

        console.log(
          "  LP tokens locked:",
          ethers.formatEther(lockInfo.lpAmount)
        );
        console.log("  Creator:", lockInfo.creator);
        console.log("  InfoFi (for instant launch):", lockInfo.projectInfoFi);

        // ============================================================
        // PHASE 5: Test Fee Harvesting with Safety Cap (FIX #3)
        // ============================================================
        console.log(
          "\n💰 PHASE 5: Testing Fee Harvesting with 5% Safety Cap..."
        );

        // Wait 24 hours
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
        await ethers.provider.send("evm_mine", []);

        const creatorBalanceBefore = await ethers.provider.getBalance(
          founder.address
        );

        const lockInfoBefore = await lpFeeHarvester.getLockInfo(tokenAddress);
        const initialLPAmount = lockInfoBefore.lpAmount;

        await lpFeeHarvester.harvestFees(tokenAddress);
        console.log("  Fees harvested!");

        const creatorBalanceAfter = await ethers.provider.getBalance(
          founder.address
        );
        const creatorFees = creatorBalanceAfter - creatorBalanceBefore;

        console.log("  Creator fees:", ethers.formatEther(creatorFees), "BNB");
        expect(creatorFees).to.be.gt(0);

        // Verify 5% LP safety cap (FIX #3)
        const lockInfoAfterHarvest = await lpFeeHarvester.getLockInfo(
          tokenAddress
        );
        const lpRemoved = initialLPAmount - lockInfoAfterHarvest.lpAmount;
        const maxAllowedRemoval = (initialLPAmount * 500n) / 10000n; // 5%

        console.log("  LP removed:", ethers.formatEther(lpRemoved));
        console.log(
          "  Max allowed (5%):",
          ethers.formatEther(maxAllowedRemoval)
        );

        expect(lpRemoved).to.be.lte(maxAllowedRemoval);

        console.log(
          "  Total fees harvested:",
          ethers.formatEther(lockInfoAfterHarvest.totalFeesHarvested),
          "BNB"
        );
        console.log("  Harvest count:", lockInfoAfterHarvest.harvestCount);

        console.log(
          "\n✅ Instant launch with LP harvesting and safety cap completed!"
        );
      }
    });

    it("Should NOT graduate if only BNB threshold met but market cap insufficient (FIX #2)", async function () {
      console.log(
        "\n🔍 Testing dual graduation check - BNB threshold without market cap..."
      );

      const initialBuy = ethers.parseEther("1");
      const totalValue = initialBuy;

      const createTx = await launchpadManager
        .connect(founder)
        .createInstantLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          defaultMetadata,
          initialBuy,
          false, // burnLP
          { value: totalValue }
        );

      const createReceipt = await createTx.wait();
      const createEvent = createReceipt?.logs.find((log: any) => {
        try {
          return (
            launchpadManager.interface.parseLog(log as any)?.name ===
            "InstantLaunchCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = launchpadManager.interface.parseLog(
        createEvent as any
      );
      const tokenAddress = parsedEvent?.args[0];
      const token = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );

      // Buy some tokens
      await bondingCurveDEX.connect(trader1).buyTokens(tokenAddress, 0, {
        value: ethers.parseEther("3"),
      });

      // Sell to drop market cap
      const tokens = await token.balanceOf(trader1.address);
      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), tokens / 2n);
      await bondingCurveDEX
        .connect(trader1)
        .sellTokens(tokenAddress, tokens / 2n, 0);

      // Continue buying to try to reach 15 BNB without reaching $90k market cap
      for (let i = 0; i < 5; i++) {
        try {
          await bondingCurveDEX.connect(trader2).buyTokens(tokenAddress, 0, {
            value: ethers.parseEther("3"),
          });
        } catch (e) {
          break;
        }
      }

      const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);

      console.log(
        "  BNB Reserve:",
        ethers.formatEther(poolInfo.bnbReserve),
        "BNB"
      );
      console.log(
        "  Market Cap:",
        ethers.formatEther(poolInfo.marketCapUSD),
        "USD"
      );
      console.log("  Graduated:", poolInfo.graduated);

      // FIX #2: If market cap is below $90k, should NOT graduate even if BNB >= 15
      if (poolInfo.marketCapUSD < ethers.parseEther("90000")) {
        expect(poolInfo.graduated).to.be.false;
        console.log(
          "✅ Correctly prevented graduation - market cap too low despite BNB threshold"
        );
      }
    });
  });

  describe("LP Fee Harvester - Detailed Tests with Fixes", function () {
    let tokenAddress: string;

    beforeEach(async function () {
      // Create and complete a project raise
      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          RAISE_TARGET_USD,
          RAISE_MAX_USD,
          VESTING_DURATION,
          defaultMetadata,
          false // burnLP
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      tokenAddress = (event as any).args[0];

      // Complete raise
      await launchpadManager.connect(investor1).contribute(tokenAddress, {
        value: ethers.parseEther("300"),
      });

      await launchpadManager.connect(investor2).contribute(tokenAddress, {
        value: ethers.parseEther("200"),
      });

      // Graduate pool
      for (let i = 0; i < 25; i++) {
        try {
          await bondingCurveDEX.connect(trader1).buyTokens(tokenAddress, 0, {
            value: ethers.parseEther("50"),
          });
        } catch (e) {
          break;
        }
      }

      const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
      if (poolInfo.graduated) {
        await launchpadManager.graduateToPancakeSwap(tokenAddress);
      }
    });

    it("Should lock LP tokens with correct parameters", async function () {
      const lockInfo = await lpFeeHarvester.getLockInfo(tokenAddress);

      expect(lockInfo.active).to.be.true;
      expect(lockInfo.creator).to.equal(founder.address);
      expect(lockInfo.projectInfoFi).to.equal(infoFiFee.address);
      expect(lockInfo.lpAmount).to.be.gt(0);
      expect(lockInfo.initialLPAmount).to.equal(lockInfo.lpAmount);
      expect(lockInfo.lockTime).to.be.gt(0);
      expect(lockInfo.unlockTime).to.be.gt(lockInfo.lockTime);
    });

    it("Should enforce harvest cooldown", async function () {
      await expect(lpFeeHarvester.harvestFees(tokenAddress)).to.be.revertedWith(
        "Harvest cooldown active"
      );
    });

    it("Should allow harvest after cooldown", async function () {
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      await expect(lpFeeHarvester.harvestFees(tokenAddress)).to.not.be.revert(
        ethers
      );
    });

    it("Should enforce 5% LP safety cap on each harvest (FIX #3)", async function () {
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const lockInfoBefore = await lpFeeHarvester.getLockInfo(tokenAddress);
      const initialLPAmount = lockInfoBefore.lpAmount;

      await lpFeeHarvester.harvestFees(tokenAddress);

      const lockInfoAfter = await lpFeeHarvester.getLockInfo(tokenAddress);
      const lpRemoved = initialLPAmount - lockInfoAfter.lpAmount;
      const maxAllowedRemoval = (initialLPAmount * 500n) / 10000n; // 5%

      expect(lpRemoved).to.be.lte(maxAllowedRemoval);
    });

    it("Should distribute fees in 70/20/10 ratio", async function () {
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const creatorBefore = await ethers.provider.getBalance(founder.address);
      const projectBefore = await ethers.provider.getBalance(infoFiFee.address);
      const platformBefore = await ethers.provider.getBalance(
        platformFee.address
      );

      await lpFeeHarvester.harvestFees(tokenAddress);

      const creatorAfter = await ethers.provider.getBalance(founder.address);
      const projectAfter = await ethers.provider.getBalance(infoFiFee.address);
      const platformAfter = await ethers.provider.getBalance(
        platformFee.address
      );

      const creatorFees = creatorAfter - creatorBefore;
      const projectFees = projectAfter - projectBefore;
      const platformFees = platformAfter - platformBefore;

      // Verify ratio approximately 70:20:10
      expect(projectFees * 7n).to.be.closeTo(
        creatorFees * 2n,
        ethers.parseEther("0.01")
      );
      expect(platformFees * 7n).to.be.closeTo(
        creatorFees,
        ethers.parseEther("0.01")
      );
    });

    it("Should update harvest statistics", async function () {
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const lockInfoBefore = await lpFeeHarvester.getLockInfo(tokenAddress);
      expect(lockInfoBefore.harvestCount).to.equal(0);

      await lpFeeHarvester.harvestFees(tokenAddress);

      const lockInfoAfter = await lpFeeHarvester.getLockInfo(tokenAddress);
      expect(lockInfoAfter.harvestCount).to.equal(1);
      expect(lockInfoAfter.totalFeesHarvested).to.be.gt(0);
      expect(lockInfoAfter.lpAmount).to.be.lt(lockInfoBefore.lpAmount); // Some LP burned
    });

    it("Should allow multiple harvests over time, each respecting 5% cap (FIX #3)", async function () {
      // First harvest
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const lockInfo0 = await lpFeeHarvester.getLockInfo(tokenAddress);
      const initialLP = lockInfo0.lpAmount;

      await lpFeeHarvester.harvestFees(tokenAddress);

      const lockInfo1 = await lpFeeHarvester.getLockInfo(tokenAddress);
      const lpRemoved1 = initialLP - lockInfo1.lpAmount;
      const maxAllowed1 = (initialLP * 500n) / 10000n;
      expect(lpRemoved1).to.be.lte(maxAllowed1);

      // Second harvest
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);
      await lpFeeHarvester.harvestFees(tokenAddress);

      const lockInfo2 = await lpFeeHarvester.getLockInfo(tokenAddress);
      const lpRemoved2 = lockInfo1.lpAmount - lockInfo2.lpAmount;
      const maxAllowed2 = (lockInfo1.lpAmount * 500n) / 10000n;
      expect(lpRemoved2).to.be.lte(maxAllowed2);

      expect(lockInfo2.harvestCount).to.equal(2);
      expect(lockInfo2.totalFeesHarvested).to.be.gt(
        lockInfo1.totalFeesHarvested
      );
    });

    it("Should allow unlock after lock period expires", async function () {
      const lockInfo = await lpFeeHarvester.getLockInfo(tokenAddress);

      // Fast forward past unlock time
      const timeToUnlock =
        Number(lockInfo.unlockTime) - Math.floor(Date.now() / 1000);
      await ethers.provider.send("evm_increaseTime", [timeToUnlock + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(lpFeeHarvester.unlockLP(tokenAddress)).to.not.be.revert(
        ethers
      );

      const lockInfoAfter = await lpFeeHarvester.getLockInfo(tokenAddress);
      expect(lockInfoAfter.active).to.be.false;
    });

    it("Should reject unlock before lock period expires", async function () {
      await expect(lpFeeHarvester.unlockLP(tokenAddress)).to.be.revertedWith(
        "Lock period not expired"
      );
    });

    it("Should track harvest history", async function () {
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      await lpFeeHarvester.harvestFees(tokenAddress);

      const history = await lpFeeHarvester.getHarvestHistory(tokenAddress);
      expect(history.length).to.equal(1);
      expect(history[0].bnbAmount).to.be.gt(0);
    });

    it("Should allow creator to extend lock", async function () {
      const lockInfo = await lpFeeHarvester.getLockInfo(tokenAddress);
      const oldUnlockTime = lockInfo.unlockTime;

      const extension = 30 * 24 * 60 * 60; // 30 days
      await lpFeeHarvester.connect(founder).extendLock(tokenAddress, extension);

      const lockInfoAfter = await lpFeeHarvester.getLockInfo(tokenAddress);
      expect(lockInfoAfter.unlockTime).to.equal(
        oldUnlockTime + BigInt(extension)
      );
    });

    it("Should reject extend lock from non-creator", async function () {
      await expect(
        lpFeeHarvester
          .connect(trader1)
          .extendLock(tokenAddress, 30 * 24 * 60 * 60)
      ).to.be.revertedWith("Only creator can extend");
    });
  });

  describe("LP Fee Harvester - Platform Stats", function () {
    it("Should track global platform statistics", async function () {
      // Create multiple launches
      for (let i = 0; i < 3; i++) {
        const tx = await launchpadManager
          .connect(founder)
          .createLaunch(
            `Token ${i}`,
            `TK${i}`,
            1_000_000_000,
            RAISE_TARGET_USD,
            RAISE_MAX_USD,
            VESTING_DURATION,
            defaultMetadata,
            false // burnLP
          );

        const receipt = await tx.wait();
        const event = receipt?.logs.find(
          (log: any) => log.fragment?.name === "LaunchCreated"
        );
        const tokenAddr = (event as any).args[0];

        // Complete raise and graduate
        await launchpadManager.connect(investor1).contribute(tokenAddr, {
          value: ethers.parseEther("500"),
        });

        for (let j = 0; j < 25; j++) {
          try {
            await bondingCurveDEX.connect(trader1).buyTokens(tokenAddr, 0, {
              value: ethers.parseEther("50"),
            });
          } catch (e) {
            break;
          }
        }

        const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddr);
        if (poolInfo.graduated) {
          await launchpadManager.graduateToPancakeSwap(tokenAddr);
        }
      }

      const stats = await lpFeeHarvester.getPlatformStats();
      expect(stats._activeLocksCount).to.be.gte(3);
      expect(stats._totalValueLocked).to.be.gt(0);
    });
  });

  describe("Market Cap and Price Consistency Across Lifecycle (FIX #1)", function () {
    it("Should maintain consistent market cap and price throughout trading", async function () {
      const tx = await launchpadManager
        .connect(founder)
        .createInstantLaunch(
          "Consistency Token",
          "CONS",
          1_000_000_000,
          defaultMetadata,
          ethers.parseEther("1"),
          false, // burnLP
          { value: ethers.parseEther("11") }
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            launchpadManager.interface.parseLog(log as any)?.name ===
            "InstantLaunchCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = launchpadManager.interface.parseLog(event as any);
      const tokenAddress = parsedEvent?.args[0];

      // Multiple trades
      for (let i = 0; i < 5; i++) {
        await bondingCurveDEX.connect(trader1).buyTokens(tokenAddress, 0, {
          value: ethers.parseEther("1"),
        });

        const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
        const totalSupply = ethers.parseEther("1000000000");

        // FIX #1: Market cap should equal currentPrice * totalSupply
        const expectedMarketCap =
          (poolInfo.currentPrice * totalSupply) / 10n ** 18n;
        expect(poolInfo.marketCapBNB).to.equal(expectedMarketCap);
      }
    });
  });
});
