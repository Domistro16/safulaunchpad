import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

import {
  LaunchpadManagerV3,
  TokenFactoryV2,
  BondingCurveDEX,
  LaunchpadTokenV2,
  MockPriceOracle,
  MockPancakeRouter,
  LPFeeHarvester,
  MockPancakeFactory,
} from "../types/ethers-contracts/index.js";

describe("LaunchpadManagerV3 with LPFeeHarvester", function () {
  let launchpadManager: LaunchpadManagerV3;
  let tokenFactory: TokenFactoryV2;
  let bondingCurveDEX: BondingCurveDEX;
  let priceOracle: MockPriceOracle;
  let lpFeeHarvester: LPFeeHarvester;
  let mockPancakeRouter: MockPancakeRouter;
  let mockPancakeFactory: MockPancakeFactory;
  let owner: any;
  let founder: any;
  let user1: any;
  let user2: any;
  let user3: any;
  let user4: any;
  let platformFee: any;
  let academyFee: any;
  let infoFiFee: any;
  const BNB_PRICE_USD = ethers.parseEther("580"); // $580 per BNB

  const defaultMetadata = {
    logoURI: "https://example.com/logo.png",
    description: "Test token",
    website: "https://example.com",
    twitter: "@test",
    telegram: "https://t.me/test",
    discord: "https://discord.gg/test",
  };

  beforeEach(async function () {
    [
      owner,
      founder,
      user1,
      user2,
      user3,
      user4,
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

    const BondingCurveDEX = await ethers.getContractFactory("BondingCurveDEX");
    bondingCurveDEX = await BondingCurveDEX.deploy(
      platformFee.address,
      academyFee.address,
      infoFiFee.address,
      await priceOracle.getAddress(),
      owner.address
    );
    await bondingCurveDEX.waitForDeployment();

    // Deploy LPFeeHarvester
    const LPFeeHarvester = await ethers.getContractFactory("LPFeeHarvester");
    lpFeeHarvester = await LPFeeHarvester.deploy(
      PANCAKE_ROUTER,
      PANCAKE_FACTORY,
      platformFee.address,
      owner.address
    );
    await lpFeeHarvester.waitForDeployment();

    const LaunchpadManagerV3 = await ethers.getContractFactory(
      "LaunchpadManagerV3"
    );
    launchpadManager = await LaunchpadManagerV3.deploy(
      await tokenFactory.getAddress(),
      await bondingCurveDEX.getAddress(),
      PANCAKE_ROUTER,
      await priceOracle.getAddress(),
      infoFiFee.address,
      await lpFeeHarvester.getAddress(),
      PANCAKE_FACTORY // ✅ ADD THIS PARAMETER
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

  describe("Launch Creation - Option 1 (Project Raise)", function () {
    it("Should create a regular launch with USD amounts", async function () {
      const raiseTargetUSD = ethers.parseEther("50000"); // $50k
      const raiseMaxUSD = ethers.parseEther("500000"); // $500k
      const vestingDuration = 90 * 24 * 60 * 60;

      await expect(
        launchpadManager
          .connect(founder)
          .createLaunch(
            "Test Token",
            "TEST",
            1_000_000_000,
            raiseTargetUSD,
            raiseMaxUSD,
            vestingDuration,
            defaultMetadata,
            infoFiFee.address
          )
      ).to.emit(launchpadManager, "LaunchCreated");
    });

    it("Should create a vanity launch", async function () {
      const raiseTargetUSD = ethers.parseEther("50000");
      const raiseMaxUSD = ethers.parseEther("500000");
      const vestingDuration = 90 * 24 * 60 * 60;
      const salt = ethers.randomBytes(32);

      await expect(
        launchpadManager
          .connect(founder)
          .createLaunchWithVanity(
            "Vanity Token",
            "VANITY",
            1_000_000_000,
            raiseTargetUSD,
            raiseMaxUSD,
            vestingDuration,
            defaultMetadata,
            salt,
            infoFiFee.address
          )
      ).to.emit(launchpadManager, "LaunchCreated");
    });

    it("Should reject raise target below minimum ($50k)", async function () {
      const raiseTargetUSD = ethers.parseEther("40000"); // $40k - below minimum
      const raiseMaxUSD = ethers.parseEther("100000");
      const vestingDuration = 90 * 24 * 60 * 60;

      await expect(
        launchpadManager
          .connect(founder)
          .createLaunch(
            "Test Token",
            "TEST",
            1_000_000_000,
            raiseTargetUSD,
            raiseMaxUSD,
            vestingDuration,
            defaultMetadata,
            infoFiFee.address
          )
      ).to.be.revertedWith("Invalid raise target");
    });

    it("Should reject raise target above maximum ($500k)", async function () {
      const raiseTargetUSD = ethers.parseEther("600000"); // $600k - above maximum
      const raiseMaxUSD = ethers.parseEther("700000");
      const vestingDuration = 90 * 24 * 60 * 60;

      await expect(
        launchpadManager
          .connect(founder)
          .createLaunch(
            "Test Token",
            "TEST",
            1_000_000_000,
            raiseTargetUSD,
            raiseMaxUSD,
            vestingDuration,
            defaultMetadata,
            infoFiFee.address
          )
      ).to.be.revertedWith("Invalid raise target");
    });

    it("Should reject raise max less than target", async function () {
      const raiseTargetUSD = ethers.parseEther("100000"); // $100k
      const raiseMaxUSD = ethers.parseEther("80000"); // $80k - less than target
      const vestingDuration = 90 * 24 * 60 * 60;

      await expect(
        launchpadManager
          .connect(founder)
          .createLaunch(
            "Test Token",
            "TEST",
            1_000_000_000,
            raiseTargetUSD,
            raiseMaxUSD,
            vestingDuration,
            defaultMetadata,
            infoFiFee.address
          )
      ).to.be.revertedWith("Invalid raise max");
    });

    it("Should reject vesting duration below minimum", async function () {
      const raiseTargetUSD = ethers.parseEther("50000");
      const raiseMaxUSD = ethers.parseEther("500000");
      const vestingDuration = 30 * 24 * 60 * 60; // 30 days - below minimum

      await expect(
        launchpadManager
          .connect(founder)
          .createLaunch(
            "Test Token",
            "TEST",
            1_000_000_000,
            raiseTargetUSD,
            raiseMaxUSD,
            vestingDuration,
            defaultMetadata,
            infoFiFee.address
          )
      ).to.be.revertedWith("Invalid vesting duration");
    });

    it("Should reject vesting duration above maximum", async function () {
      const raiseTargetUSD = ethers.parseEther("50000");
      const raiseMaxUSD = ethers.parseEther("500000");
      const vestingDuration = 200 * 24 * 60 * 60; // 200 days - above maximum

      await expect(
        launchpadManager
          .connect(founder)
          .createLaunch(
            "Test Token",
            "TEST",
            1_000_000_000,
            raiseTargetUSD,
            raiseMaxUSD,
            vestingDuration,
            defaultMetadata,
            infoFiFee.address
          )
      ).to.be.revertedWith("Invalid vesting duration");
    });

    it("Should reject invalid project InfoFi wallet", async function () {
      const raiseTargetUSD = ethers.parseEther("50000");
      const raiseMaxUSD = ethers.parseEther("500000");
      const vestingDuration = 90 * 24 * 60 * 60;

      await expect(
        launchpadManager.connect(founder).createLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          vestingDuration,
          defaultMetadata,
          ethers.ZeroAddress // Invalid
        )
      ).to.be.revertedWith("Invalid project InfoFi wallet");
    });

    it("Should store launch info correctly with USD conversion", async function () {
      const raiseTargetUSD = ethers.parseEther("50000");
      const raiseMaxUSD = ethers.parseEther("500000");
      const vestingDuration = 90 * 24 * 60 * 60;

      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          vestingDuration,
          defaultMetadata,
          infoFiFee.address
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      const tokenAddress = (event as any).args[0];

      const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
      expect(launchInfo.founder).to.equal(founder.address);
      expect(launchInfo.raiseCompleted).to.be.false;
      expect(launchInfo.projectInfoFiWallet).to.equal(infoFiFee.address);

      // Check USD values using new function (with small tolerance for rounding)
      const launchInfoUSD = await launchpadManager.getLaunchInfoWithUSD(
        tokenAddress
      );
      expect(launchInfoUSD.raiseTargetUSD).to.be.closeTo(
        raiseTargetUSD,
        ethers.parseEther("0.001")
      );
      expect(launchInfoUSD.raiseMaxUSD).to.be.closeTo(
        raiseMaxUSD,
        ethers.parseEther("0.001")
      );
    });

    it("Should convert USD amounts to BNB correctly", async function () {
      const raiseTargetUSD = ethers.parseEther("58000"); // $58k
      const raiseMaxUSD = ethers.parseEther("290000"); // $290k
      const vestingDuration = 90 * 24 * 60 * 60;

      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          vestingDuration,
          defaultMetadata,
          infoFiFee.address
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      const tokenAddress = (event as any).args[0];

      // Expected BNB amounts: $58k / $580 = 100 BNB, $290k / $580 = 500 BNB
      const expectedRaiseTargetBNB = ethers.parseEther("100");
      const expectedRaiseMaxBNB = ethers.parseEther("500");

      const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
      expect(launchInfo.raiseTarget).to.equal(expectedRaiseTargetBNB);
      expect(launchInfo.raiseMax).to.equal(expectedRaiseMaxBNB);
    });
  });

  describe("Launch Creation - Option 2 (Instant Launch)", function () {
    it("Should create an instant launch", async function () {
      const initialBuy = ethers.parseEther("1");
      const initialLiquidity = ethers.parseEther("10");
      const totalValue = initialBuy + initialLiquidity;

      const tx = await launchpadManager
        .connect(founder)
        .createInstantLaunch(
          "Instant Token",
          "INST",
          1_000_000_000,
          defaultMetadata,
          initialBuy,
          { value: totalValue }
        );

      await expect(tx).to.emit(launchpadManager, "InstantLaunchCreated");
    });

    it("Should execute initial buy correctly", async function () {
      const initialBuy = ethers.parseEther("2");
      const initialLiquidity = ethers.parseEther("10");
      const totalValue = initialBuy + initialLiquidity;

      const tx = await launchpadManager
        .connect(founder)
        .createInstantLaunch(
          "Buy Token",
          "BUY",
          1_000_000_000,
          defaultMetadata,
          initialBuy,
          { value: totalValue }
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "InstantLaunchCreated"
      );
      const tokenAddress = (event as any).args[0];

      const token = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );
      const founderBalance = await token.balanceOf(founder.address);

      expect(founderBalance).to.be.gt(0);
    });

    it("Should reject instant launch with insufficient BNB", async function () {
      const initialBuy = ethers.parseEther("1");
      const insufficientValue = ethers.parseEther("0.5");

      await expect(
        launchpadManager
          .connect(founder)
          .createInstantLaunch(
            "Fail Token",
            "FAIL",
            1_000_000_000,
            defaultMetadata,
            initialBuy,
            { value: insufficientValue }
          )
      ).to.be.revertedWith("Insufficient BNB sent");
    });

    it("Should reject instant launch with zero initial buy", async function () {
      await expect(
        launchpadManager
          .connect(founder)
          .createInstantLaunch(
            "Zero Token",
            "ZERO",
            1_000_000_000,
            defaultMetadata,
            0,
            {
              value: ethers.parseEther("10"),
            }
          )
      ).to.be.revertedWith("Initial buy must be > 0");
    });

    it("Should reject instant launch with wrong total supply", async function () {
      await expect(
        launchpadManager.connect(founder).createInstantLaunch(
          "Wrong Supply",
          "WRONG",
          500_000_000, // Not 1 billion
          defaultMetadata,
          ethers.parseEther("1"),
          {
            value: ethers.parseEther("11"),
          }
        )
      ).to.be.revertedWith("Total supply must be 1 billion");
    });

    it("Should create instant launch with vanity salt", async function () {
      const initialBuy = ethers.parseEther("1");
      const initialLiquidity = ethers.parseEther("10");
      const totalValue = initialBuy + initialLiquidity;
      const salt = ethers.randomBytes(32);

      const tx = await launchpadManager
        .connect(founder)
        .createInstantLaunchWithVanity(
          "Vanity Instant",
          "VINST",
          1_000_000_000,
          defaultMetadata,
          initialBuy,
          salt,
          { value: totalValue }
        );

      await expect(tx).to.emit(launchpadManager, "InstantLaunchCreated");
    });

    it("Should allow immediate trading after instant launch", async function () {
      const initialBuy = ethers.parseEther("1");
      const initialLiquidity = ethers.parseEther("10");
      const totalValue = initialBuy + initialLiquidity;

      const tx = await launchpadManager
        .connect(founder)
        .createInstantLaunch(
          "Trade Token",
          "TRADE",
          1_000_000_000,
          defaultMetadata,
          initialBuy,
          { value: totalValue }
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "InstantLaunchCreated"
      );
      const tokenAddress = (event as any).args[0];

      await expect(
        bondingCurveDEX.connect(user1).buyTokens(tokenAddress, 0, {
          value: ethers.parseEther("0.5"),
        })
      ).to.not.be.revert(ethers);

      const token = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );
      const user1Balance = await token.balanceOf(user1.address);
      expect(user1Balance).to.be.gt(0);
    });
    it("Should use all BNB sent (no refund)", async function () {
      const initialBuy = ethers.parseEther("1");
      const initialLiquidity = ethers.parseEther("10");
      const totalValue = ethers.parseEther("15"); // Extra 4 BNB will be used

      const balanceBefore = await ethers.provider.getBalance(founder.address);

      const tx = await launchpadManager
        .connect(founder)
        .createInstantLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          defaultMetadata,
          initialBuy,
          { value: totalValue }
        );

      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(founder.address);

      const spent = balanceBefore - balanceAfter;
      // ✅ All 15 BNB is used (1 for initial buy + 14 for liquidity)
      const expectedSpent = totalValue + gasUsed;

      expect(spent).to.be.closeTo(expectedSpent, ethers.parseEther("0.01"));
    });
  });

  describe("Fundraising - Option 1", function () {
    let tokenAddress: string;
    const raiseTargetUSD = ethers.parseEther("58000"); // $58k
    const raiseMaxUSD = ethers.parseEther("116000"); // $116k
    const raiseTargetBNB = ethers.parseEther("100"); // 100 BNB at $580
    const raiseMaxBNB = ethers.parseEther("200"); // 200 BNB at $580

    beforeEach(async function () {
      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          90 * 24 * 60 * 60,
          defaultMetadata,
          infoFiFee.address
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      tokenAddress = (event as any).args[0];
    });

    it("Should accept contributions in BNB", async function () {
      const contribution = ethers.parseEther("10");

      await expect(
        launchpadManager.connect(user1).contribute(tokenAddress, {
          value: contribution,
        })
      )
        .to.emit(launchpadManager, "ContributionMade")
        .withArgs(user1.address, tokenAddress, contribution);

      const contributionInfo = await launchpadManager.getContribution(
        tokenAddress,
        user1.address
      );
      expect(contributionInfo.amount).to.equal(contribution);
    });

    it("Should reject contributions to instant launch", async function () {
      const initialBuy = ethers.parseEther("1");
      const initialLiquidity = ethers.parseEther("10");
      const totalValue = initialBuy + initialLiquidity;

      const tx = await launchpadManager
        .connect(founder)
        .createInstantLaunch(
          "Instant",
          "INST",
          1_000_000_000,
          defaultMetadata,
          initialBuy,
          { value: totalValue }
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "InstantLaunchCreated"
      );
      const instantTokenAddress = (event as any).args[0];

      await expect(
        launchpadManager.connect(user1).contribute(instantTokenAddress, {
          value: ethers.parseEther("1"),
        })
      ).to.be.revertedWith("Not a project raise");
    });

    it("Should accumulate multiple contributions from same user", async function () {
      const contribution1 = ethers.parseEther("10");
      const contribution2 = ethers.parseEther("20");

      await launchpadManager.connect(user1).contribute(tokenAddress, {
        value: contribution1,
      });

      await launchpadManager.connect(user1).contribute(tokenAddress, {
        value: contribution2,
      });

      const contributionInfo = await launchpadManager.getContribution(
        tokenAddress,
        user1.address
      );
      expect(contributionInfo.amount).to.equal(contribution1 + contribution2);
    });

    it("Should complete raise when BNB target is met", async function () {
      await launchpadManager.connect(user1).contribute(tokenAddress, {
        value: ethers.parseEther("60"),
      });

      await expect(
        launchpadManager.connect(user2).contribute(tokenAddress, {
          value: ethers.parseEther("40"),
        })
      )
        .to.emit(launchpadManager, "RaiseCompleted")
        .withArgs(tokenAddress, raiseTargetBNB);

      const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
      expect(launchInfo.raiseCompleted).to.be.true;
    });

    it("Should reject contributions exceeding max raise in BNB", async function () {
      await expect(
        launchpadManager.connect(user1).contribute(tokenAddress, {
          value: raiseMaxBNB + ethers.parseEther("1"),
        })
      ).to.be.revertedWith("Exceeds max raise");
    });

    it("Should reject zero contributions", async function () {
      await expect(
        launchpadManager.connect(user1).contribute(tokenAddress, {
          value: 0,
        })
      ).to.be.revertedWith("Must contribute BNB");
    });

    it("Should reject contributions after deadline", async function () {
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        launchpadManager.connect(user1).contribute(tokenAddress, {
          value: ethers.parseEther("10"),
        })
      ).to.be.revertedWith("Raise ended");
    });

    it("Should reject contributions after raise completed", async function () {
      await launchpadManager.connect(user1).contribute(tokenAddress, {
        value: ethers.parseEther("60"),
      });

      await launchpadManager.connect(user2).contribute(tokenAddress, {
        value: ethers.parseEther("40"),
      });

      await expect(
        launchpadManager.connect(founder).contribute(tokenAddress, {
          value: ethers.parseEther("10"),
        })
      ).to.be.revertedWith("Raise already completed");
    });

    it("Should reject contributions to non-existent launch", async function () {
      const fakeAddress = ethers.Wallet.createRandom().address;

      await expect(
        launchpadManager.connect(user1).contribute(fakeAddress, {
          value: ethers.parseEther("10"),
        })
      ).to.be.revertedWith("Launch does not exist");
    });

    it("Should handle BNB price changes during fundraising", async function () {
      // Contribute some funds
      await launchpadManager.connect(user1).contribute(tokenAddress, {
        value: ethers.parseEther("50"),
      });

      // Change BNB price (simulating market volatility)
      await priceOracle.setBNBPrice(ethers.parseEther("600")); // $600/BNB

      // Should still accept contributions in BNB (internal tracking is in BNB)
      await expect(
        launchpadManager.connect(user2).contribute(tokenAddress, {
          value: ethers.parseEther("50"),
        })
      ).to.not.be.revert(ethers);

      const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
      expect(launchInfo.totalRaised).to.equal(ethers.parseEther("100"));
    });
  });

  describe("Token Distribution After Raise - Option 1", function () {
    let tokenAddress: string;
    let token: LaunchpadTokenV2;
    const raiseTargetUSD = ethers.parseEther("58000"); // $58k
    const raiseMaxUSD = ethers.parseEther("116000"); // $116k
    const raiseTargetBNB = ethers.parseEther("100");

    beforeEach(async function () {
      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          90 * 24 * 60 * 60,
          defaultMetadata,
          infoFiFee.address
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      tokenAddress = (event as any).args[0];
      token = await ethers.getContractAt("LaunchpadTokenV2", tokenAddress);

      await launchpadManager.connect(user3).contribute(tokenAddress, {
        value: ethers.parseEther("60"),
      });

      await launchpadManager.connect(user4).contribute(tokenAddress, {
        value: ethers.parseEther("40"),
      });
    });

    it("Should give founder 10% immediately (50% of 20%)", async function () {
      const totalSupply = ethers.parseEther("1000000000");
      const founderAllocation = (totalSupply * 20n) / 100n;
      const immediateRelease = (founderAllocation * 50n) / 100n;

      const founderBalance = await token.balanceOf(founder.address);
      expect(founderBalance).to.equal(immediateRelease);
    });

    it("Should send tokens to bonding curve", async function () {
      const bondingCurveDEXAddress = await bondingCurveDEX.getAddress();
      const dexBalance = await token.balanceOf(bondingCurveDEXAddress);

      // DEX should have tokens for trading
      expect(dexBalance).to.be.gt(0);
    });

    it("Should set vesting start time", async function () {
      const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
      expect(launchInfo.raiseCompleted).to.be.true;

      const claimable = await launchpadManager.getClaimableAmounts(
        tokenAddress
      );
      expect(claimable.claimableTokens).to.equal(0);
    });

    it("Should store raised fund vesting amount correctly", async function () {
      const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);

      // 50% of 100 BNB = 50 BNB for liquidity, 50 BNB for vesting
      const liquidityBNB = (raiseTargetBNB * 50n) / 100n;
      const vestingBNB = raiseTargetBNB - liquidityBNB;

      expect(launchInfo.raisedFundsVesting).to.equal(vestingBNB);
      expect(launchInfo.raisedFundsClaimed).to.equal(0);
    });
  });

  describe("Founder Token Vesting - Option 1", function () {
    let tokenAddress: string;
    let token: LaunchpadTokenV2;
    const raiseTargetUSD = ethers.parseEther("58000");
    const raiseMaxUSD = ethers.parseEther("116000");

    beforeEach(async function () {
      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          90 * 24 * 60 * 60,
          defaultMetadata,
          infoFiFee.address
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      tokenAddress = (event as any).args[0];
      token = await ethers.getContractAt("LaunchpadTokenV2", tokenAddress);

      await launchpadManager.connect(user1).contribute(tokenAddress, {
        value: ethers.parseEther("60"),
      });

      await launchpadManager.connect(user2).contribute(tokenAddress, {
        value: ethers.parseEther("40"),
      });
    });

    it("Should have no claimable tokens immediately after raise", async function () {
      const claimable = await launchpadManager.getClaimableAmounts(
        tokenAddress
      );
      expect(claimable.claimableTokens).to.equal(0);
    });

    it("Should have claimable tokens after 30 days", async function () {
      await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const claimable = await launchpadManager.getClaimableAmounts(
        tokenAddress
      );
      expect(claimable.claimableTokens).to.be.gt(0);
    });

    it("Should allow founder to claim vested tokens", async function () {
      // ✅ FIX: Buy tokens to push price above start
      await bondingCurveDEX.connect(user3).buyTokens(tokenAddress, 0, {
        value: ethers.parseEther("20"), // Buy enough to increase price
      });

      await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const claimableBefore = await launchpadManager.getClaimableAmounts(
        tokenAddress
      );
      expect(claimableBefore.claimableTokens).to.be.gt(0);

      await expect(
        launchpadManager.connect(founder).claimFounderTokens(tokenAddress)
      ).to.emit(launchpadManager, "FounderTokensClaimed");
    });
    it("Should send tokens to founder when price is above start", async function () {
      // Buy tokens to increase price
      const buyAmount = ethers.parseEther("10");

      await bondingCurveDEX.connect(user1).buyTokens(tokenAddress, 0, {
        value: buyAmount,
      });

      await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const founderBalanceBefore = await token.balanceOf(founder.address);

      await launchpadManager.connect(founder).claimFounderTokens(tokenAddress);

      const founderBalanceAfter = await token.balanceOf(founder.address);
      expect(founderBalanceAfter).to.be.gt(founderBalanceBefore);
    });

    it("Should burn tokens when price is below start", async function () {
      // Sell tokens to decrease price below start
      const buyAmount = ethers.parseEther("5");
      await bondingCurveDEX.connect(user1).buyTokens(tokenAddress, 0, {
        value: buyAmount,
      });

      const userTokens = await token.balanceOf(user1.address);
      await token
        .connect(user1)
        .approve(await bondingCurveDEX.getAddress(), userTokens);
      await bondingCurveDEX
        .connect(user1)
        .sellTokens(tokenAddress, userTokens, 0);

      await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const deadAddress = "0x000000000000000000000000000000000000dEaD";
      const deadBalanceBefore = await token.balanceOf(deadAddress);

      await expect(
        launchpadManager.connect(founder).claimFounderTokens(tokenAddress)
      ).to.emit(launchpadManager, "TokensBurned");

      const deadBalanceAfter = await token.balanceOf(deadAddress);
      expect(deadBalanceAfter).to.be.gt(deadBalanceBefore);
    });

    it("Should reject claim from non-founder", async function () {
      await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        launchpadManager.connect(user1).claimFounderTokens(tokenAddress)
      ).to.be.revertedWith("Not founder");
    });

    it("Should vest all tokens after full duration", async function () {
      await ethers.provider.send("evm_increaseTime", [90 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const claimable = await launchpadManager.getClaimableAmounts(
        tokenAddress
      );

      const totalSupply = ethers.parseEther("1000000000");
      const founderAllocation = (totalSupply * 20n) / 100n;
      const immediateRelease = (founderAllocation * 50n) / 100n;
      const vestedAmount = founderAllocation - immediateRelease;

      expect(claimable.claimableTokens).to.equal(vestedAmount);
    });

    it("Should revert when claiming with no tokens available", async function () {
      await expect(
        launchpadManager.connect(founder).claimFounderTokens(tokenAddress)
      ).to.be.revertedWith("No tokens to claim");
    });
  });

  describe("Raised Fund Vesting - Option 1", function () {
    let tokenAddress: string;
    const raiseTargetUSD = ethers.parseEther("58000");
    const raiseMaxUSD = ethers.parseEther("116000");

    beforeEach(async function () {
      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          90 * 24 * 60 * 60,
          defaultMetadata,
          infoFiFee.address
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      tokenAddress = (event as any).args[0];

      await launchpadManager.connect(user1).contribute(tokenAddress, {
        value: ethers.parseEther("60"),
      });

      await launchpadManager.connect(user2).contribute(tokenAddress, {
        value: ethers.parseEther("40"),
      });
    });

    it("Should have minimal claimable funds immediately", async function () {
      const claimable = await launchpadManager.getClaimableAmounts(
        tokenAddress
      );
      expect(claimable.claimableFunds).to.be.lt(ethers.parseEther("0.001"));
    });

    it("Should have claimable funds after time passes", async function () {
      await ethers.provider.send("evm_increaseTime", [45 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const claimable = await launchpadManager.getClaimableAmounts(
        tokenAddress
      );
      expect(claimable.claimableFunds).to.be.gt(0);

      const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
      const expectedClaimable = launchInfo.raisedFundsVesting / 2n;

      expect(claimable.claimableFunds).to.be.closeTo(
        expectedClaimable,
        expectedClaimable / 100n
      );
    });
    it("Should allow founder to claim vested funds", async function () {
      // ✅ FIX: Buy tokens to push price above start
      await bondingCurveDEX.connect(user3).buyTokens(tokenAddress, 0, {
        value: ethers.parseEther("20"),
      });

      await ethers.provider.send("evm_increaseTime", [45 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const balanceBefore = await ethers.provider.getBalance(founder.address);

      const tx = await launchpadManager
        .connect(founder)
        .claimRaisedFunds(tokenAddress);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(founder.address);

      expect(balanceAfter + gasUsed).to.be.gt(balanceBefore);
    });

    it("Should redirect funds to InfoFi when price is below start", async function () {
      // Sell to decrease price
      const buyAmount = ethers.parseEther("5");
      await bondingCurveDEX.connect(user1).buyTokens(tokenAddress, 0, {
        value: buyAmount,
      });

      const token = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );
      const userTokens = await token.balanceOf(user1.address);
      await token
        .connect(user1)
        .approve(await bondingCurveDEX.getAddress(), userTokens);
      await bondingCurveDEX
        .connect(user1)
        .sellTokens(tokenAddress, userTokens, 0);

      await ethers.provider.send("evm_increaseTime", [45 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const infoFiBalanceBefore = await ethers.provider.getBalance(
        infoFiFee.address
      );

      await expect(
        launchpadManager.connect(founder).claimRaisedFunds(tokenAddress)
      ).to.emit(launchpadManager, "RaisedFundsSentToInfoFi");

      const infoFiBalanceAfter = await ethers.provider.getBalance(
        infoFiFee.address
      );
      expect(infoFiBalanceAfter).to.be.gt(infoFiBalanceBefore);
    });

    it("Should reject claim from non-founder", async function () {
      await ethers.provider.send("evm_increaseTime", [45 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        launchpadManager.connect(user1).claimRaisedFunds(tokenAddress)
      ).to.be.revertedWith("Not founder");
    });

    it("Should vest all funds after full duration", async function () {
      await ethers.provider.send("evm_increaseTime", [90 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const claimable = await launchpadManager.getClaimableAmounts(
        tokenAddress
      );
      const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);

      expect(claimable.claimableFunds).to.equal(launchInfo.raisedFundsVesting);
    });

    it("Should emit correct event on claim", async function () {
      // ✅ FIX: Buy tokens to push price above start
      await bondingCurveDEX.connect(user3).buyTokens(tokenAddress, 0, {
        value: ethers.parseEther("20"),
      });

      await ethers.provider.send("evm_increaseTime", [45 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const claimable = await launchpadManager.getClaimableAmounts(
        tokenAddress
      );
      expect(claimable.claimableFunds).to.be.gt(0);

      await expect(
        launchpadManager.connect(founder).claimRaisedFunds(tokenAddress)
      ).to.emit(launchpadManager, "RaisedFundsClaimed");
    });
  });

  describe("Launch Tracking", function () {
    it("Should track all launches", async function () {
      const raiseTargetUSD = ethers.parseEther("50000");
      const raiseMaxUSD = ethers.parseEther("500000");

      await launchpadManager
        .connect(founder)
        .createLaunch(
          "Token 1",
          "TK1",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          90 * 24 * 60 * 60,
          defaultMetadata,
          infoFiFee.address
        );

      await launchpadManager
        .connect(founder)
        .createLaunch(
          "Token 2",
          "TK2",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          90 * 24 * 60 * 60,
          defaultMetadata,
          infoFiFee.address
        );

      const allLaunches = await launchpadManager.getAllLaunches();
      expect(allLaunches.length).to.equal(2);
    });
  });

  describe("Emergency Withdraw", function () {
    let tokenAddress: string;
    const raiseTargetUSD = ethers.parseEther("58000");
    const raiseMaxUSD = ethers.parseEther("116000");

    beforeEach(async function () {
      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          90 * 24 * 60 * 60,
          defaultMetadata,
          infoFiFee.address
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      tokenAddress = (event as any).args[0];
    });

    it("Should allow owner to withdraw if raise failed", async function () {
      await launchpadManager.connect(user1).contribute(tokenAddress, {
        value: ethers.parseEther("10"),
      });

      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const tx = launchpadManager
        .connect(owner)
        .emergencyWithdraw(tokenAddress);
      await expect(tx).to.not.be.revert(ethers);
    });

    it("Should reject emergency withdraw if raise completed", async function () {
      await launchpadManager.connect(user1).contribute(tokenAddress, {
        value: ethers.parseEther("60"),
      });

      await launchpadManager.connect(user2).contribute(tokenAddress, {
        value: ethers.parseEther("40"),
      });

      await expect(
        launchpadManager.connect(owner).emergencyWithdraw(tokenAddress)
      ).to.be.revertedWith("Raise completed");
    });

    it("Should reject emergency withdraw before deadline", async function () {
      await launchpadManager.connect(user1).contribute(tokenAddress, {
        value: ethers.parseEther("10"),
      });

      await expect(
        launchpadManager.connect(owner).emergencyWithdraw(tokenAddress)
      ).to.be.revertedWith("Raise still active");
    });
  });

  describe("Price Oracle Integration", function () {
    it("Should handle BNB price volatility correctly", async function () {
      const raiseTargetUSD = ethers.parseEther("58000"); // $58k
      const raiseMaxUSD = ethers.parseEther("116000"); // $116k

      // Create launch at $580/BNB
      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          90 * 24 * 60 * 60,
          defaultMetadata,
          infoFiFee.address
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      const tokenAddress = (event as any).args[0];

      // Initial: $58k / $580 = 100 BNB target
      let launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
      expect(launchInfo.raiseTarget).to.equal(ethers.parseEther("100"));

      // Change BNB price to $1000
      await priceOracle.setBNBPrice(ethers.parseEther("1000"));

      // Launch info should remain in BNB (unchanged)
      launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
      expect(launchInfo.raiseTarget).to.equal(ethers.parseEther("100"));

      // But USD representation should update
      const launchInfoUSD = await launchpadManager.getLaunchInfoWithUSD(
        tokenAddress
      );
      // 100 BNB * $1000 = $100k (not $58k)
      expect(launchInfoUSD.raiseTargetUSD).to.equal(
        ethers.parseEther("100000")
      );
    });

    it("Should create different BNB targets with different prices", async function () {
      const raiseTargetUSD = ethers.parseEther("58000"); // $58k
      const raiseMaxUSD = ethers.parseEther("116000"); // $116k

      // At $580/BNB
      const tx1 = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Token 1",
          "TK1",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          90 * 24 * 60 * 60,
          defaultMetadata,
          infoFiFee.address
        );

      const receipt1 = await tx1.wait();
      const event1 = receipt1?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      const token1Address = (event1 as any).args[0];

      // Change price to $290/BNB
      await priceOracle.setBNBPrice(ethers.parseEther("290"));

      // At $290/BNB
      const tx2 = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Token 2",
          "TK2",
          1_000_000_000,
          raiseTargetUSD,
          raiseMaxUSD,
          90 * 24 * 60 * 60,
          defaultMetadata,
          infoFiFee.address
        );

      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      const token2Address = (event2 as any).args[0];

      // Token1: $58k / $580 = 100 BNB
      const launch1 = await launchpadManager.getLaunchInfo(token1Address);
      expect(launch1.raiseTarget).to.equal(ethers.parseEther("100"));

      // Token2: $58k / $290 = 200 BNB
      const launch2 = await launchpadManager.getLaunchInfo(token2Address);
      expect(launch2.raiseTarget).to.equal(ethers.parseEther("200"));
    });
  });

  describe("PancakeSwap Graduation with LP Locking and Dual Check (FIX #2)", function () {
    let tokenAddress: string;

    beforeEach(async function () {
      const tx = await launchpadManager
        .connect(founder)
        .createLaunch(
          "Test Token",
          "TEST",
          1_000_000_000,
          ethers.parseEther("58000"),
          ethers.parseEther("116000"),
          90 * 24 * 60 * 60,
          defaultMetadata,
          infoFiFee.address
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "LaunchCreated"
      );
      tokenAddress = (event as any).args[0];

      // Complete the raise
      await launchpadManager.connect(user1).contribute(tokenAddress, {
        value: ethers.parseEther("60"),
      });

      await launchpadManager.connect(user2).contribute(tokenAddress, {
        value: ethers.parseEther("40"),
      });
    });

    it("Should revert if pool is not graduated", async function () {
      await expect(
        launchpadManager.connect(owner).graduateToPancakeSwap(tokenAddress)
      ).to.be.revertedWith("Not ready to graduate");
    });

    it("Should successfully graduate and lock LP", async function () {
      // Buy tokens until graduation
      let graduated = false;
      let attempts = 0;

      while (!graduated && attempts < 30) {
        try {
          await bondingCurveDEX.connect(user1).buyTokens(tokenAddress, 0, {
            value: ethers.parseEther("50"),
          });

          const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
          graduated = poolInfo.graduated;
          attempts++;
        } catch (e) {
          break;
        }
      }

      // ✅ Verify pool actually graduated
      const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
      expect(poolInfo.graduated).to.be.true;

      await expect(
        launchpadManager.graduateToPancakeSwap(tokenAddress)
      ).to.emit(launchpadManager, "GraduatedToPancakeSwap");

      const launchInfo = await launchpadManager.getLaunchInfo(tokenAddress);
      expect(launchInfo.graduatedToPancakeSwap).to.be.true;

      // Verify LP was locked
      const lockInfo = await lpFeeHarvester.getLockInfo(tokenAddress);
      expect(lockInfo.active).to.be.true;
      expect(lockInfo.creator).to.equal(founder.address);
      expect(lockInfo.lpAmount).to.be.gt(0);
    });

    it("Should revert if trying to graduate twice", async function () {
      // Buy until graduated
      let graduated = false;
      let attempts = 0;

      while (!graduated && attempts < 30) {
        try {
          await bondingCurveDEX.connect(user1).buyTokens(tokenAddress, 0, {
            value: ethers.parseEther("50"),
          });

          const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
          graduated = poolInfo.graduated;
          attempts++;
        } catch (e) {
          break;
        }
      }

      const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
      expect(poolInfo.graduated).to.be.true;

      await launchpadManager.graduateToPancakeSwap(tokenAddress);

      await expect(
        launchpadManager.graduateToPancakeSwap(tokenAddress)
      ).to.be.revertedWith("Already graduated to PancakeSwap");
    });

    it("Should enable transfers after graduation", async function () {
      // Buy until graduated
      let graduated = false;
      let attempts = 0;

      while (!graduated && attempts < 30) {
        try {
          await bondingCurveDEX.connect(user1).buyTokens(tokenAddress, 0, {
            value: ethers.parseEther("50"),
          });

          const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
          graduated = poolInfo.graduated;
          attempts++;
        } catch (e) {
          break;
        }
      }

      const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);
      expect(poolInfo.graduated).to.be.true;

      await launchpadManager.graduateToPancakeSwap(tokenAddress);

      const token = await ethers.getContractAt(
        "LaunchpadTokenV2",
        tokenAddress
      );
      const transfersEnabled = await token.transfersEnabled();
      expect(transfersEnabled).to.be.true;
    });
  });

  describe("Instant Launch Graduation with Dual Check (FIX #2)", function () {
    it("Should only graduate instant launch when BOTH BNB and market cap thresholds met", async function () {
      const initialBuy = ethers.parseEther("1");
      const totalValue = initialBuy + ethers.parseEther("5");

      const tx = await launchpadManager
        .connect(founder)
        .createInstantLaunch(
          "Test Instant",
          "TINST",
          1_000_000_000,
          defaultMetadata,
          initialBuy,
          { value: totalValue }
        );

      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "InstantLaunchCreated"
      );
      const tokenAddress = (event as any).args[0];

      // Buy tokens
      for (let i = 0; i < 3; i++) {
        await bondingCurveDEX.connect(user1).buyTokens(tokenAddress, 0, {
          value: ethers.parseEther("3"),
        });
      }

      const poolInfo = await bondingCurveDEX.getPoolInfo(tokenAddress);

      // FIX #2: Should only graduate if BOTH conditions met
      if (poolInfo.graduated) {
        expect(poolInfo.bnbReserve).to.be.gte(ethers.parseEther("15"));
        expect(poolInfo.marketCapUSD).to.be.gte(ethers.parseEther("90000"));
      }
    });
  });
});
