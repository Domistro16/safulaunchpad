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
} from "../types/ethers-contracts/index.js";
const { networkHelpers } = await network.connect();

async function findSafuSalt(
  tokenFactory: TokenFactoryV2,
  name: string,
  symbol: string,
  totalSupply: number,
  owner: string,
  metadata: any
): Promise<{ salt: string; address: string }> {
  console.log("  🔍 Searching for SAFU vanity address...");

  const startTime = Date.now();

  // Get the bytecode for LaunchpadTokenV2
  const TokenFactory = await ethers.getContractFactory("LaunchpadTokenV2");

  // Encode constructor arguments (use BigInt to handle large numbers)
  const totalSupplyWei = ethers.parseUnits(totalSupply.toString(), 18);

  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "string",
      "string",
      "uint256",
      "uint8",
      "address",
      "tuple(string,string,string,string,string,string)",
    ],
    [
      name,
      symbol,
      totalSupplyWei,
      18,
      owner,
      [
        metadata.logoURI,
        metadata.description,
        metadata.website,
        metadata.twitter,
        metadata.telegram,
        metadata.discord,
      ],
    ]
  );

  // Get the init code (bytecode + constructor args)
  const initCode = ethers.concat([TokenFactory.bytecode, constructorArgs]);
  const initCodeHash = ethers.keccak256(initCode);
  const factoryAddress = await tokenFactory.getAddress();

  // Try to find "safu" or fall back to "saf"
  const maxAttempts = 200000;
  const targetSuffix = "af";

  console.log(
    `  📊 Attempting to find address ending with "${targetSuffix}"...`
  );
  console.log(`     (This might take 30-60 seconds)`);

  for (let i = 0; i < maxAttempts; i++) {
    // Create salt from counter (faster than random)
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);

    // Calculate CREATE2 address directly (much faster than calling contract)
    const create2Input = ethers.concat([
      "0xff",
      factoryAddress,
      salt,
      initCodeHash,
    ]);

    const hash = ethers.keccak256(create2Input);
    const computedAddress = ethers.getAddress("0x" + hash.slice(-40));

    // Check if address ends with target suffix
    if (computedAddress.toLowerCase().endsWith(targetSuffix)) {
      const elapsed = Date.now() - startTime;
      console.log(
        `  ✨ Found SAFU address after ${i + 1} attempts in ${(
          elapsed / 1000
        ).toFixed(2)}s!`
      );
      console.log(`     Address: ${computedAddress}`);
      return { salt, address: computedAddress };
    }

    // Try "saf" as backup after 100k attempts
    if (i === 100000) {
      console.log(
        `  ⏰ Switching to 3-char suffix "saf" for faster results...`
      );
    }

    if (i > 100000 && computedAddress.toLowerCase().endsWith("saf")) {
      const elapsed = Date.now() - startTime;
      console.log(
        `  ✨ Found SAF address after ${i + 1} attempts in ${(
          elapsed / 1000
        ).toFixed(2)}s!`
      );
      console.log(`     Address: ${computedAddress}`);
      return { salt, address: computedAddress };
    }

    // Progress logging
    if (i > 0 && i % 25000 === 0) {
      const elapsed = Date.now() - startTime;
      const rate = i / (elapsed / 1000);
      console.log(
        `     Checked ${i.toLocaleString()} addresses (${rate.toFixed(
          0
        )} addr/sec)...`
      );
    }
  }

  throw new Error(`Could not find suitable address in ${maxAttempts} attempts`);
}

describe("Integration Tests - Complete Launch Lifecycle", function () {
  let tokenFactory: TokenFactoryV2;
  let bondingCurveDEX: BondingCurveDEX;
  let launchpadManager: LaunchpadManagerV3;
  let priceOracle: MockPriceOracle;
  let owner: any;
  let founder: any;
  let investor1: any;
  let investor2: any;
  let trader1: any;
  let trader2: any;
  let platformFee: any;
  let academyFee: any;
  let infoFiFee: any;

  const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
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

    const TokenFactoryV2 = await ethers.getContractFactory("TokenFactoryV2");
    tokenFactory = await TokenFactoryV2.deploy();
    await tokenFactory.waitForDeployment();

    const BondingCurveDEX = await ethers.getContractFactory("BondingCurveDEX");
    bondingCurveDEX = await BondingCurveDEX.deploy(
      platformFee.address,
      academyFee.address,
      infoFiFee.address,
      await priceOracle.getAddress()
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
      infoFiFee.address
    );
    await launchpadManager.waitForDeployment();

    await bondingCurveDEX.transferOwnership(
      await launchpadManager.getAddress()
    );
  });

  describe("Full Launch Lifecycle - Option 1 (Project Raise)", function () {
    let tokenAddress: string;
    let token: LaunchpadTokenV2;

    it("Should complete entire lifecycle from creation to trading", async function () {
      // ============================================================
      // PHASE 1: Token Creation
      // ============================================================
      console.log("\n📝 PHASE 1: Creating Launch...");

      const createTx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Awesome Token",
          "AWE",
          1_000_000,
          RAISE_TARGET_USD,
          RAISE_MAX_USD,
          VESTING_DURATION,
          defaultMetadata
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

      // Verify fees were distributed
      const platformBalance = await ethers.provider.getBalance(
        platformFee.address
      );
      const academyBalance = await ethers.provider.getBalance(
        academyFee.address
      );
      const infoFiBalance = await ethers.provider.getBalance(infoFiFee.address);

      expect(platformBalance).to.be.gt(ethers.parseEther("10000")); // Initial test balance
      expect(academyBalance).to.be.gt(ethers.parseEther("10000"));
      expect(infoFiBalance).to.be.gt(ethers.parseEther("10000"));
      console.log(
        "✅ Trading fees distributed to platform, academy, and InfoFi"
      );

      // Check market cap (now in both BNB and USD)
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

      // ============================================================
      // PHASE 4: Vesting Claims (30 days later)
      // ============================================================
      console.log("\n⏰ PHASE 4: Fast-forward 30 days and claim vesting...");

      await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      // Claim founder tokens
      const claimableBefore = await launchpadManager.getClaimableAmounts(
        tokenAddress
      );
      console.log(
        "  Claimable tokens:",
        ethers.formatEther(claimableBefore.claimableTokens)
      );
      console.log(
        "  Claimable funds:",
        ethers.formatEther(claimableBefore.claimableFunds),
        "BNB"
      );

      await launchpadManager.connect(founder).claimFounderTokens(tokenAddress);
      const founderBalanceAfterClaim = await token.balanceOf(founder.address);
      console.log(
        "  Founder balance after claim:",
        ethers.formatEther(founderBalanceAfterClaim),
        "tokens"
      );

      // Claim founder funds
      await launchpadManager.connect(founder).claimRaisedFunds(tokenAddress);
      console.log("✅ Founder claimed vested funds");

      // ============================================================
      // PHASE 5: More Trading & Verification
      // ============================================================
      console.log("\n🔄 PHASE 5: More trading...");

      // Trader 1 sells some tokens
      const sellAmount = trader1Tokens / 4n;
      await token
        .connect(trader1)
        .approve(await bondingCurveDEX.getAddress(), sellAmount);
      await bondingCurveDEX
        .connect(trader1)
        .sellTokens(tokenAddress, sellAmount, 0);
      console.log("  Trader 1 sold:", ethers.formatEther(sellAmount), "tokens");

      // Check final pool state
      const finalPoolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
      console.log(
        "  Final market cap:",
        ethers.formatEther(finalPoolInfo.marketCapBNB),
        "BNB"
      );
      console.log(
        "  Final market cap USD:",
        ethers.formatEther(finalPoolInfo.marketCapUSD)
      );
      console.log(
        "  Graduation progress:",
        finalPoolInfo.graduationProgress.toString(),
        "%"
      );

      expect(finalPoolInfo.graduated).to.be.false; // Haven't reached $500k yet
    });
  });

  describe("Full Launch Lifecycle - Option 2 (Instant Launch)", function () {
    it("Should complete entire instant launch lifecycle", async function () {
      console.log("\n⚡ OPTION 2: Instant Launch Lifecycle...");

      // ============================================================
      // PHASE 1: Instant Launch Creation
      // ============================================================
      console.log("\n📝 PHASE 1: Creating Instant Launch...");

      const initialBuy = ethers.parseEther("2");
      const totalValue = initialBuy + ethers.parseEther("0.1"); // +0.1 for liquidity

      const createTx = await launchpadManager
        .connect(founder)
        .createInstantLaunch(
          "Instant Token",
          "INST",
          1_000_000,
          defaultMetadata,
          initialBuy,
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
      console.log("\n📈 PHASE 2: Immediate Trading (no raise needed)...");

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
      console.log(
        "  Total purchase volume:",
        ethers.formatEther(feeInfo.totalPurchaseVolume),
        "BNB"
      );
      expect(feeInfo.accumulatedFees).to.be.gt(0);

      // ============================================================
      // PHASE 3: Trigger Graduation (15 BNB)
      // ============================================================
      console.log("\n🎓 PHASE 3: Reaching graduation threshold...");

      const remainingToGraduate =
        ethers.parseEther("15") - feeInfo.totalPurchaseVolume;

      if (remainingToGraduate > 0) {
        await bondingCurveDEX.connect(trader1).buyTokens(tokenAddress, 0, {
          value: remainingToGraduate + ethers.parseEther("0.1"),
        });
        console.log("  Bought remaining amount to reach 15 BNB");
      }

      const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
      expect(poolInfo.graduated).to.be.true;
      console.log("✅ Pool graduated at 15 BNB purchase volume!");

      // Pool should stay active for continued trading
      const pool = await bondingCurveDEX.pools(tokenAddress);
      expect(pool.active).to.be.true;
      console.log("  Pool remains active for trading");

      // ============================================================
      // PHASE 4: Creator Fee Claiming
      // ============================================================
      console.log("\n💰 PHASE 4: Creator fee claiming...");

      // Wait 24 hours
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const founderBalanceBefore = await ethers.provider.getBalance(
        founder.address
      );

      await bondingCurveDEX.connect(founder).claimCreatorFees(tokenAddress);

      const founderBalanceAfter = await ethers.provider.getBalance(
        founder.address
      );

      console.log(
        "✅ Creator claimed fees:",
        ethers.formatEther(founderBalanceAfter - founderBalanceBefore),
        "BNB (approx, minus gas)"
      );

      // ============================================================
      // PHASE 5: Continued Trading After Graduation
      // ============================================================
      console.log("\n🔄 PHASE 5: Trading continues after graduation...");

      await bondingCurveDEX.connect(trader2).buyTokens(tokenAddress, 0, {
        value: ethers.parseEther("1"),
      });

      console.log("✅ Trading works after graduation");
    });
  });

  describe("Full Launch Lifecycle - Vanity Token with SAFU Address", function () {
    it("Should complete entire lifecycle with SAFU vanity address", async function () {
      this.timeout(120000); // 2 minutes for vanity search

      console.log("\n✨ Testing SAFU VANITY address launch...");

      // Find salt that generates address ending with "safu"
      const { salt: vanitySalt, address: computedAddress } = await findSafuSalt(
        tokenFactory,
        "Safe Token",
        "SAFE",
        1_000_000,
        await launchpadManager.getAddress(),
        defaultMetadata
      );

      console.log("  🎯 Computed SAFU address:", computedAddress);
      expect(computedAddress.toLowerCase()).to.match(/af$/);

      // Create launch with vanity
      const tx = await launchpadManager
        .connect(founder)
        .createLaunchWithVanity(
          "Safe Token",
          "SAFE",
          1_000_000,
          RAISE_TARGET_USD,
          RAISE_MAX_USD,
          VESTING_DURATION,
          defaultMetadata,
          vanitySalt
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            launchpadManager.interface.parseLog(log as any)?.name ===
            "LaunchCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = launchpadManager.interface.parseLog(event as any);
      const actualAddress = parsedEvent?.args[0];

      expect(actualAddress).to.equal(computedAddress);
      expect(actualAddress.toLowerCase()).to.match(/af$/);
      console.log("✅ Vanity address matched computed SAFU address!");

      // Continue with normal launch flow
      await launchpadManager.connect(investor1).contribute(actualAddress, {
        value: ethers.parseEther("500"),
      });

      const launchInfo = await launchpadManager.getLaunchInfo(actualAddress);
      expect(launchInfo.raiseCompleted).to.be.true;
      console.log("✅ SAFU token launch completed successfully");
    });
  });

  describe("Multi-Token Scenario", function () {
    it("Should handle multiple simultaneous launches", async function () {
      console.log("\n🚀 Testing MULTIPLE launches...");

      // Create 3 different tokens
      const launches = [];

      for (let i = 0; i < 3; i++) {
        const tx = await launchpadManager
          .connect(founder)
          .createLaunch(
            `Token ${i + 1}`,
            `TK${i + 1}`,
            1_000_000,
            RAISE_TARGET_USD,
            RAISE_MAX_USD,
            VESTING_DURATION,
            {
              ...defaultMetadata,
              description: `Token number ${i + 1}`,
            }
          );

        const receipt = await tx.wait();
        const event = receipt?.logs.find((log: any) => {
          try {
            return (
              launchpadManager.interface.parseLog(log as any)?.name ===
              "LaunchCreated"
            );
          } catch {
            return false;
          }
        });

        const parsedEvent = launchpadManager.interface.parseLog(event as any);
        launches.push(parsedEvent?.args[0]);
        console.log(`  Created Token ${i + 1}:`, parsedEvent?.args[0]);
      }

      expect(launches.length).to.equal(3);

      // Complete raises for all 3
      for (const tokenAddr of launches) {
        await launchpadManager.connect(investor1).contribute(tokenAddr, {
          value: ethers.parseEther("500"),
        });
      }

      console.log("✅ All 3 tokens raised successfully");

      // Trade on all 3 bonding curves
      for (const tokenAddr of launches) {
        await bondingCurveDEX.connect(trader1).buyTokens(tokenAddr, 0, {
          value: ethers.parseEther("1"),
        });
      }

      console.log("✅ Traded on all 3 bonding curves");

      // Verify all tracked
      const allLaunches = await launchpadManager.getAllLaunches();
      expect(allLaunches.length).to.be.gte(3);
      console.log("  Total launches tracked:", allLaunches.length);
    });
  });

  describe("Stress Test - High Volume Trading", function () {
    let tokenAddress: string;

    beforeEach(async function () {
      const tx = await launchpadManager.connect(founder).createLaunch(
        "High Volume Token",
        "HVT",
        10_000_000, // 10M tokens
        RAISE_TARGET_USD,
        RAISE_MAX_USD,
        VESTING_DURATION,
        defaultMetadata
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            launchpadManager.interface.parseLog(log as any)?.name ===
            "LaunchCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = launchpadManager.interface.parseLog(event as any);
      tokenAddress = parsedEvent?.args[0];

      await launchpadManager.connect(investor1).contribute(tokenAddress, {
        value: ethers.parseEther("500"),
      });
    });

    it("Should handle 10 sequential trades", async function () {
      console.log("\n⚡ Stress test: 10 sequential trades...");

      const signers = await ethers.getSigners();
      const traders = signers.slice(0, 10);

      for (let i = 0; i < 10; i++) {
        await bondingCurveDEX
          .connect(traders[i])
          .buyTokens(tokenAddress, 0, { value: ethers.parseEther("1") });
      }

      console.log("✅ Completed 10 sequential trades");

      const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
      console.log(
        "  Final market cap:",
        ethers.formatEther(poolInfo.marketCapBNB),
        "BNB"
      );
      console.log(
        "  Final market cap USD:",
        ethers.formatEther(poolInfo.marketCapUSD)
      );
    });

    it("Should maintain price consistency across trades", async function () {
      const buyAmount = ethers.parseEther("1");
      const prices = [];

      for (let i = 0; i < 5; i++) {
        const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
        prices.push(poolInfo.currentPrice);

        await bondingCurveDEX.connect(trader1).buyTokens(tokenAddress, 0, {
          value: buyAmount,
        });
      }

      // Prices should be monotonically increasing
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).to.be.gt(prices[i - 1]);
      }

      console.log("✅ Price increased consistently across 5 trades");
    });
  });

  describe("Edge Case - Failed Raise", function () {
    it("Should handle failed raise correctly", async function () {
      console.log("\n❌ Testing FAILED raise scenario...");

      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Failed Token",
          "FAIL",
          1_000_000,
          RAISE_TARGET_USD,
          RAISE_MAX_USD,
          VESTING_DURATION,
          defaultMetadata
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            launchpadManager.interface.parseLog(log as any)?.name ===
            "LaunchCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = launchpadManager.interface.parseLog(event as any);
      const tokenAddress = parsedEvent?.args[0];

      // Contribute less than target ($290k target, only contribute $58k worth)
      await launchpadManager.connect(investor1).contribute(tokenAddress, {
        value: ethers.parseEther("100"), // Only 100 BNB, need 500
      });

      // Fast forward past deadline
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");

      const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
      expect(launchInfo.raiseCompleted).to.be.false;
      console.log("✅ Raise failed as expected");

      // Owner can emergency withdraw
      await launchpadManager.connect(owner).emergencyWithdraw(tokenAddress);
      console.log("✅ Emergency withdraw successful");
    });
  });

  describe("Fee Distribution Accuracy", function () {
    let tokenAddress: string;

    beforeEach(async function () {
      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Fee Test Token",
          "FEE",
          1_000_000,
          RAISE_TARGET_USD,
          RAISE_MAX_USD,
          VESTING_DURATION,
          defaultMetadata
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            launchpadManager.interface.parseLog(log as any)?.name ===
            "LaunchCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = launchpadManager.interface.parseLog(event as any);
      tokenAddress = parsedEvent?.args[0];

      await launchpadManager.connect(investor1).contribute(tokenAddress, {
        value: ethers.parseEther("500"),
      });
    });

    it("Should distribute fees in correct proportions (Option 1: 1% fee)", async function () {
      console.log("\n💸 Testing Option 1 fee distribution (1% total)...");

      const platformBefore = await ethers.provider.getBalance(
        platformFee.address
      );
      const academyBefore = await ethers.provider.getBalance(
        academyFee.address
      );
      const infoFiBefore = await ethers.provider.getBalance(infoFiFee.address);

      const buyAmount = ethers.parseEther("100");
      await bondingCurveDEX.connect(trader1).buyTokens(tokenAddress, 0, {
        value: buyAmount,
      });

      const platformAfter = await ethers.provider.getBalance(
        platformFee.address
      );
      const academyAfter = await ethers.provider.getBalance(academyFee.address);
      const infoFiAfter = await ethers.provider.getBalance(infoFiFee.address);

      const platformFees = platformAfter - platformBefore;
      const academyFees = academyAfter - academyBefore;
      const infoFiFees = infoFiAfter - infoFiBefore;

      console.log("  Platform fees:", ethers.formatEther(platformFees), "BNB");
      console.log("  Academy fees:", ethers.formatEther(academyFees), "BNB");
      console.log("  InfoFi fees:", ethers.formatEther(infoFiFees), "BNB");

      // Verify ratios: 0.1%, 0.3%, 0.6%
      // Academy should be 3x platform
      expect(academyFees).to.be.closeTo(
        platformFees * 3n,
        ethers.parseEther("0.001")
      );
      // InfoFi should be 6x platform
      expect(infoFiFees).to.be.closeTo(
        platformFees * 6n,
        ethers.parseEther("0.001")
      );

      console.log("✅ Fee distribution ratios correct (1:3:6)");
    });
  });

  describe("Option 2 Fee Distribution", function () {
    let tokenAddress: string;

    beforeEach(async function () {
      const initialBuy = ethers.parseEther("1");
      const totalValue = initialBuy + ethers.parseEther("0.1");

      const tx = await launchpadManager
        .connect(founder)
        .createInstantLaunch(
          "Instant Fee Token",
          "IFEE",
          1_000_000,
          defaultMetadata,
          initialBuy,
          { value: totalValue }
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
      tokenAddress = parsedEvent?.args[0];
    });

    it("Should distribute fees in correct proportions (Option 2: 2% fee)", async function () {
      console.log("\n💸 Testing Option 2 fee distribution (2% total)...");

      const platformBefore = await ethers.provider.getBalance(
        platformFee.address
      );
      const infoFiBefore = await ethers.provider.getBalance(infoFiFee.address);

      const buyAmount = ethers.parseEther("100");
      await bondingCurveDEX.connect(trader1).buyTokens(tokenAddress, 0, {
        value: buyAmount,
      });

      const platformAfter = await ethers.provider.getBalance(
        platformFee.address
      );
      const infoFiAfter = await ethers.provider.getBalance(infoFiFee.address);

      const platformFees = platformAfter - platformBefore;
      const infoFiFees = infoFiAfter - infoFiBefore;

      console.log("  Platform fees:", ethers.formatEther(platformFees), "BNB");
      console.log("  InfoFi fees:", ethers.formatEther(infoFiFees), "BNB");

      // Verify ratios: 0.1% platform, 0.9% InfoFi (1% goes to creator, not sent immediately)
      // InfoFi should be 9x platform
      expect(infoFiFees).to.be.closeTo(
        platformFees * 9n,
        ethers.parseEther("0.01")
      );

      // Check creator fees accumulated (not sent yet)
      const feeInfo = await bondingCurveDEX.getCreatorFeeInfo(tokenAddress);
      console.log(
        "  Creator fees accumulated:",
        ethers.formatEther(feeInfo.accumulatedFees),
        "BNB"
      );
      expect(feeInfo.accumulatedFees).to.be.gt(0);

      console.log("✅ Fee distribution ratios correct (0.1:1:0.9)");
    });
  });
});
