import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

import {
  LPFeeHarvester,
  TokenFactoryV2,
  LaunchpadTokenV2,
  MockPancakeRouter,
  MockPancakePair,
  MockPancakeFactory,
} from "../types/ethers-contracts/index.js";
import { parseEther } from "ethers";

describe("LPFeeHarvester", function () {
  let lpFeeHarvester: LPFeeHarvester;
  let tokenFactory: TokenFactoryV2;
  let mockPancakeRouter: MockPancakeRouter;
  let mockPancakeFactory: MockPancakeFactory;
  let mockPancakePair: MockPancakePair;
  let projectToken: LaunchpadTokenV2;
  let owner: any;
  let creator: any;
  let projectInfoFi: any;
  let platformFee: any;
  let user1: any;
  let user2: any;

  const defaultMetadata = {
    logoURI: "https://example.com/logo.png",
    description: "Test token",
    website: "https://example.com",
    twitter: "@test",
    telegram: "https://t.me/test",
    discord: "https://discord.gg/test",
  };

  const HARVEST_COOLDOWN = 24 * 60 * 60; // 24 hours
  const DEFAULT_LOCK_DURATION = 365 * 24 * 60 * 60; // 365 days

  beforeEach(async function () {
    [owner, creator, projectInfoFi, platformFee, user1, user2] =
      await ethers.getSigners();

    const MockPancakeRouter = await ethers.getContractFactory(
      "MockPancakeRouter"
    );
    mockPancakeRouter = await MockPancakeRouter.deploy();
    await mockPancakeRouter.waitForDeployment();

    const MockPancakeFactory = await ethers.getContractFactory(
      "MockPancakeFactory"
    );
    mockPancakeFactory = await MockPancakeFactory.deploy();
    await mockPancakeFactory.waitForDeployment();

    await mockPancakeRouter.setFactory(await mockPancakeFactory.getAddress());

    await owner.sendTransaction({
      to: await mockPancakeRouter.getAddress(),
      value: ethers.parseEther("10"), // Plenty of ETH for all tests
    });
    const LPFeeHarvester = await ethers.getContractFactory("LPFeeHarvester");
    lpFeeHarvester = await LPFeeHarvester.deploy(
      await mockPancakeRouter.getAddress(),
      await mockPancakeFactory.getAddress(),
      platformFee.address,
      owner.address // admin
    );
    await lpFeeHarvester.waitForDeployment();

    const TokenFactoryV2 = await ethers.getContractFactory("TokenFactoryV2");
    tokenFactory = await TokenFactoryV2.deploy();
    await tokenFactory.waitForDeployment();

    const tx = await tokenFactory.createToken(
      "Project Token",
      "PROJ",
      1_000_000_000,
      18,
      owner.address,
      defaultMetadata
    );

    const receipt = await tx.wait();
    const event = receipt?.logs?.find((log: any) => {
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
    projectToken = await ethers.getContractAt("LaunchpadTokenV2", tokenAddress);
    await projectToken.enableTransfers();
    // ✅ FIXED: Register the pair in the factory
    await mockPancakeFactory.createPair(
      await projectToken.getAddress(),
      "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"
    );

    const pair = await mockPancakeFactory.getPair(
      await projectToken.getAddress(),
      "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"
    );

    mockPancakePair = await ethers.getContractAt("MockPancakePair", pair);
    await mockPancakePair.mint(owner.address, parseEther("100"));
    const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
    await lpFeeHarvester.grantRole(MANAGER_ROLE, owner.address);
  });

  describe("LP Locking", function () {
    it("Should lock LP tokens successfully", async function () {
      const lpAmount = ethers.parseEther("100");

      await mockPancakePair.mint(owner.address, lpAmount);

      await mockPancakePair.approve(
        await lpFeeHarvester.getAddress(),
        lpAmount
      );

      await expect(
        lpFeeHarvester.lockLP(
          await projectToken.getAddress(),
          await mockPancakePair.getAddress(),
          creator.address,
          projectInfoFi.address,
          lpAmount,
          DEFAULT_LOCK_DURATION
        )
      ).to.emit(lpFeeHarvester, "LPLocked");

      const lockInfo = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );

      expect(lockInfo.active).to.be.true;
      expect(lockInfo.creator).to.equal(creator.address);
      expect(lockInfo.projectInfoFi).to.equal(projectInfoFi.address);
      expect(lockInfo.lpAmount).to.equal(lpAmount);
      expect(lockInfo.initialLPAmount).to.equal(lpAmount);
    });

    it("Should reject locking LP for existing project", async function () {
      const lpAmount = ethers.parseEther("100");

      await mockPancakePair.mint(owner.address, lpAmount);
      await mockPancakePair.approve(
        await lpFeeHarvester.getAddress(),
        lpAmount
      );

      await lpFeeHarvester.lockLP(
        await projectToken.getAddress(),
        await mockPancakePair.getAddress(),
        creator.address,
        projectInfoFi.address,
        lpAmount,
        DEFAULT_LOCK_DURATION
      );

      await expect(
        lpFeeHarvester.lockLP(
          await projectToken.getAddress(),
          await mockPancakePair.getAddress(),
          creator.address,
          projectInfoFi.address,
          lpAmount,
          DEFAULT_LOCK_DURATION
        )
      ).to.be.revertedWith("LP already locked");
    });

    it("Should reject invalid lock parameters", async function () {
      const lpAmount = ethers.parseEther("100");

      await expect(
        lpFeeHarvester.lockLP(
          ethers.ZeroAddress,
          await mockPancakePair.getAddress(),
          creator.address,
          projectInfoFi.address,
          lpAmount,
          DEFAULT_LOCK_DURATION
        )
      ).to.be.revertedWith("Invalid project token");

      await expect(
        lpFeeHarvester.lockLP(
          await projectToken.getAddress(),
          ethers.ZeroAddress,
          creator.address,
          projectInfoFi.address,
          lpAmount,
          DEFAULT_LOCK_DURATION
        )
      ).to.be.revertedWith("Invalid LP token");

      await expect(
        lpFeeHarvester.lockLP(
          await projectToken.getAddress(),
          await mockPancakePair.getAddress(),
          ethers.ZeroAddress,
          projectInfoFi.address,
          lpAmount,
          DEFAULT_LOCK_DURATION
        )
      ).to.be.revertedWith("Invalid creator");

      await expect(
        lpFeeHarvester.lockLP(
          await projectToken.getAddress(),
          await mockPancakePair.getAddress(),
          creator.address,
          ethers.ZeroAddress,
          lpAmount,
          DEFAULT_LOCK_DURATION
        )
      ).to.be.revertedWith("Invalid InfoFi wallet");

      await expect(
        lpFeeHarvester.lockLP(
          await projectToken.getAddress(),
          await mockPancakePair.getAddress(),
          creator.address,
          projectInfoFi.address,
          0,
          DEFAULT_LOCK_DURATION
        )
      ).to.be.revertedWith("LP amount must be > 0");
    });

    it("Should use default lock duration if zero provided", async function () {
      const lpAmount = ethers.parseEther("100");

      await mockPancakePair.mint(owner.address, lpAmount);
      await mockPancakePair.approve(
        await lpFeeHarvester.getAddress(),
        lpAmount
      );

      await lpFeeHarvester.lockLP(
        await projectToken.getAddress(),
        await mockPancakePair.getAddress(),
        creator.address,
        projectInfoFi.address,
        lpAmount,
        0 // Zero duration
      );

      const lockInfo = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );

      const expectedUnlockTime =
        lockInfo.lockTime + BigInt(DEFAULT_LOCK_DURATION);
      expect(lockInfo.unlockTime).to.equal(expectedUnlockTime);
    });

    it("Should snapshot reserves and totalSupply at lock time", async function () {
      // Create a completely fresh token for this test
      const tx2 = await tokenFactory.createToken(
        "Snapshot Test Token",
        "SNAP",
        1_000_000_000,
        18,
        owner.address,
        defaultMetadata
      );

      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs?.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(log as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent2 = tokenFactory.interface.parseLog(event2 as any);
      const token2Address = parsedEvent2?.args.tokenAddress;
      const token2 = await ethers.getContractAt(
        "LaunchpadTokenV2",
        token2Address
      );

      await token2.enableTransfers();

      await mockPancakeFactory.createPair(
        token2Address,
        "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"
      );

      const pair2Address = await mockPancakeFactory.getPair(
        token2Address,
        "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"
      );

      const pair2 = await ethers.getContractAt("MockPancakePair", pair2Address);

      // Set reserves FIRST
      await pair2.setReserves(
        ethers.parseEther("1000"),
        ethers.parseEther("10")
      );

      const lpAmount = ethers.parseEther("100");

      // Mint AFTER setting reserves
      await pair2.mint(owner.address, lpAmount);
      await pair2.approve(await lpFeeHarvester.getAddress(), lpAmount);

      await lpFeeHarvester.lockLP(
        token2Address,
        pair2Address,
        creator.address,
        projectInfoFi.address,
        lpAmount,
        DEFAULT_LOCK_DURATION
      );

      const lock = await lpFeeHarvester.lpLocks(token2Address);

      expect(lock.initialReserve0).to.equal(ethers.parseEther("1000"));
      expect(lock.initialReserve1).to.equal(ethers.parseEther("10"));
      expect(lock.initialTotalSupply).to.equal(lpAmount);
    });
  });

  describe("Fee Harvesting", function () {
    beforeEach(async function () {
      const lpAmount = ethers.parseEther("100");

      await mockPancakePair.setReserves(
        ethers.parseEther("1000"),
        ethers.parseEther("10")
      );

      await mockPancakePair.mint(owner.address, lpAmount);
      await mockPancakePair.approve(
        await lpFeeHarvester.getAddress(),
        lpAmount
      );

      await lpFeeHarvester.lockLP(
        await projectToken.getAddress(),
        await mockPancakePair.getAddress(),
        creator.address,
        projectInfoFi.address,
        lpAmount,
        DEFAULT_LOCK_DURATION
      );
    });

    it("Should enforce 24-hour harvest cooldown", async function () {
      await expect(
        lpFeeHarvester.harvestFees(await projectToken.getAddress())
      ).to.be.revertedWith("Harvest cooldown active");
    });

    it("Should allow harvest after cooldown period", async function () {
      await mockPancakePair.setReserves(
        ethers.parseEther("1100"),
        ethers.parseEther("11")
      );

      await ethers.provider.send("evm_increaseTime", [HARVEST_COOLDOWN]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        lpFeeHarvester.harvestFees(await projectToken.getAddress())
      ).to.not.be.revert(ethers);
    });

    it("Should enforce 5% LP removal safety cap (FIX #3)", async function () {
      const lockInfo = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );
      const initialLPAmount = lockInfo.lpAmount;

      await mockPancakePair.setReserves(
        ethers.parseEther("2000"),
        ethers.parseEther("20")
      );

      await ethers.provider.send("evm_increaseTime", [HARVEST_COOLDOWN]);
      await ethers.provider.send("evm_mine", []);

      await lpFeeHarvester.harvestFees(await projectToken.getAddress());

      const lockInfoAfter = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );

      const lpRemoved = initialLPAmount - lockInfoAfter.lpAmount;
      const maxAllowedRemoval = (initialLPAmount * 500n) / 10000n; // 5%

      expect(lpRemoved).to.be.lte(maxAllowedRemoval);
    });

    it("Should allow multiple harvests respecting 5% cap each time (FIX #3)", async function () {
      await mockPancakePair.setReserves(
        ethers.parseEther("1100"),
        ethers.parseEther("11")
      );

      await ethers.provider.send("evm_increaseTime", [HARVEST_COOLDOWN]);
      await ethers.provider.send("evm_mine", []);

      await lpFeeHarvester.harvestFees(await projectToken.getAddress());

      const lockInfo1 = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );
      expect(lockInfo1.harvestCount).to.equal(1);

      await mockPancakePair.setReserves(
        ethers.parseEther("1200"),
        ethers.parseEther("12")
      );

      await ethers.provider.send("evm_increaseTime", [HARVEST_COOLDOWN]);
      await ethers.provider.send("evm_mine", []);

      await lpFeeHarvester.harvestFees(await projectToken.getAddress());

      const lockInfo2 = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );
      expect(lockInfo2.harvestCount).to.equal(2);

      const lpRemoved = lockInfo1.lpAmount - lockInfo2.lpAmount;
      const maxAllowedRemoval = (lockInfo1.lpAmount * 500n) / 10000n;

      expect(lpRemoved).to.be.lte(maxAllowedRemoval);
    });

    it("Should distribute fees in 70/20/10 ratio", async function () {
      await mockPancakePair.setReserves(
        ethers.parseEther("1100"),
        ethers.parseEther("11")
      );

      await ethers.provider.send("evm_increaseTime", [HARVEST_COOLDOWN]);
      await ethers.provider.send("evm_mine", []);

      const creatorBalanceBefore = await ethers.provider.getBalance(
        creator.address
      );
      const projectBalanceBefore = await ethers.provider.getBalance(
        projectInfoFi.address
      );
      const platformBalanceBefore = await ethers.provider.getBalance(
        platformFee.address
      );

      await lpFeeHarvester.harvestFees(await projectToken.getAddress());

      const creatorBalanceAfter = await ethers.provider.getBalance(
        creator.address
      );
      const projectBalanceAfter = await ethers.provider.getBalance(
        projectInfoFi.address
      );
      const platformBalanceAfter = await ethers.provider.getBalance(
        platformFee.address
      );

      const creatorFees = creatorBalanceAfter - creatorBalanceBefore;
      const projectFees = projectBalanceAfter - projectBalanceBefore;
      const platformFees = platformBalanceAfter - platformBalanceBefore;

      expect(creatorFees).to.be.gt(0);
      expect(projectFees).to.be.gt(0);
      expect(platformFees).to.be.gt(0);

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
      await mockPancakePair.setReserves(
        ethers.parseEther("1100"),
        ethers.parseEther("11")
      );

      await ethers.provider.send("evm_increaseTime", [HARVEST_COOLDOWN]);
      await ethers.provider.send("evm_mine", []);

      const lockInfoBefore = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );

      await lpFeeHarvester.harvestFees(await projectToken.getAddress());

      const lockInfoAfter = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );

      expect(lockInfoAfter.harvestCount).to.equal(1);
      expect(lockInfoAfter.totalFeesHarvested).to.be.gt(0);
      expect(lockInfoAfter.lpAmount).to.be.lt(lockInfoBefore.lpAmount);
      expect(lockInfoAfter.lastHarvestTime).to.be.gt(
        lockInfoBefore.lastHarvestTime
      );
    });

    it("Should emit FeesHarvested event", async function () {
      await mockPancakePair.setReserves(
        ethers.parseEther("1100"),
        ethers.parseEther("11")
      );

      await ethers.provider.send("evm_increaseTime", [HARVEST_COOLDOWN]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        lpFeeHarvester.harvestFees(await projectToken.getAddress())
      ).to.emit(lpFeeHarvester, "FeesHarvested");
    });

    it("Should record harvest history", async function () {
      await mockPancakePair.setReserves(
        ethers.parseEther("1100"),
        ethers.parseEther("11")
      );

      await ethers.provider.send("evm_increaseTime", [HARVEST_COOLDOWN]);
      await ethers.provider.send("evm_mine", []);

      await lpFeeHarvester.harvestFees(await projectToken.getAddress());

      const history = await lpFeeHarvester.getHarvestHistory(
        await projectToken.getAddress()
      );

      expect(history.length).to.equal(1);
      expect(history[0].bnbAmount).to.be.gt(0);
      expect(history[0].lpBurned).to.be.gt(0);
      expect(history[0].timestamp).to.be.gt(0);
    });

    it("Should reject harvest when no active lock", async function () {
      const fakeToken = ethers.Wallet.createRandom().address;

      await expect(lpFeeHarvester.harvestFees(fakeToken)).to.be.revertedWith(
        "No active lock"
      );
    });

    it("Should reject harvest with insufficient fees", async function () {
      await ethers.provider.send("evm_increaseTime", [HARVEST_COOLDOWN]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        lpFeeHarvester.harvestFees(await projectToken.getAddress())
      ).to.be.revertedWith("Harvest amount too small");
    });
  });

  describe("LP Unlocking", function () {
    beforeEach(async function () {
      const lpAmount = ethers.parseEther("100");

      await mockPancakePair.setReserves(
        ethers.parseEther("1000"),
        ethers.parseEther("10")
      );

      await mockPancakePair.mint(owner.address, lpAmount);
      await mockPancakePair.approve(
        await lpFeeHarvester.getAddress(),
        lpAmount
      );

      await lpFeeHarvester.lockLP(
        await projectToken.getAddress(),
        await mockPancakePair.getAddress(),
        creator.address,
        projectInfoFi.address,
        lpAmount,
        DEFAULT_LOCK_DURATION
      );
    });

    it("Should reject unlock before lock period expires", async function () {
      await expect(
        lpFeeHarvester.unlockLP(await projectToken.getAddress())
      ).to.be.revertedWith("Lock period not expired");
    });

    it("Should allow unlock after lock period expires", async function () {
      await ethers.provider.send("evm_increaseTime", [DEFAULT_LOCK_DURATION]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        lpFeeHarvester.unlockLP(await projectToken.getAddress())
      ).to.not.be.revert(ethers);

      const lockInfoAfter = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );
      expect(lockInfoAfter.active).to.be.false;
    });

    it("Should transfer remaining LP to creator on unlock", async function () {
      await ethers.provider.send("evm_increaseTime", [DEFAULT_LOCK_DURATION]);
      await ethers.provider.send("evm_mine", []);

      const creatorBalanceBefore = await mockPancakePair.balanceOf(
        creator.address
      );

      await lpFeeHarvester.unlockLP(await projectToken.getAddress());

      const creatorBalanceAfter = await mockPancakePair.balanceOf(
        creator.address
      );

      expect(creatorBalanceAfter).to.be.gt(creatorBalanceBefore);
    });

    it("Should emit LPUnlocked event", async function () {
      await ethers.provider.send("evm_increaseTime", [DEFAULT_LOCK_DURATION]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        lpFeeHarvester.unlockLP(await projectToken.getAddress())
      ).to.emit(lpFeeHarvester, "LPUnlocked");
    });
  });

  describe("Lock Extension", function () {
    beforeEach(async function () {
      const lpAmount = ethers.parseEther("100");

      await mockPancakePair.setReserves(
        ethers.parseEther("1000"),
        ethers.parseEther("10")
      );

      await mockPancakePair.mint(owner.address, lpAmount);
      await mockPancakePair.approve(
        await lpFeeHarvester.getAddress(),
        lpAmount
      );

      await lpFeeHarvester.lockLP(
        await projectToken.getAddress(),
        await mockPancakePair.getAddress(),
        creator.address,
        projectInfoFi.address,
        lpAmount,
        DEFAULT_LOCK_DURATION
      );
    });

    it("Should allow creator to extend lock", async function () {
      const lockInfoBefore = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );

      const extension = 30 * 24 * 60 * 60; // 30 days

      await lpFeeHarvester
        .connect(creator)
        .extendLock(await projectToken.getAddress(), extension);

      const lockInfoAfter = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );

      expect(lockInfoAfter.unlockTime).to.equal(
        lockInfoBefore.unlockTime + BigInt(extension)
      );
    });

    it("Should reject extension from non-creator", async function () {
      const extension = 30 * 24 * 60 * 60;

      await expect(
        lpFeeHarvester
          .connect(user1)
          .extendLock(await projectToken.getAddress(), extension)
      ).to.be.revertedWith("Only creator can extend");
    });

    it("Should reject zero extension", async function () {
      await expect(
        lpFeeHarvester
          .connect(creator)
          .extendLock(await projectToken.getAddress(), 0)
      ).to.be.revertedWith("Duration must be > 0");
    });

    it("Should emit LockExtended event", async function () {
      const extension = 30 * 24 * 60 * 60;

      await expect(
        lpFeeHarvester
          .connect(creator)
          .extendLock(await projectToken.getAddress(), extension)
      ).to.emit(lpFeeHarvester, "LockExtended");
    });
  });

  describe("Emergency Functions", function () {
    beforeEach(async function () {
      const lpAmount = ethers.parseEther("100");

      await mockPancakePair.setReserves(
        ethers.parseEther("1000"),
        ethers.parseEther("10")
      );

      await mockPancakePair.mint(owner.address, lpAmount);
      await mockPancakePair.approve(
        await lpFeeHarvester.getAddress(),
        lpAmount
      );

      await lpFeeHarvester.lockLP(
        await projectToken.getAddress(),
        await mockPancakePair.getAddress(),
        creator.address,
        projectInfoFi.address,
        lpAmount,
        DEFAULT_LOCK_DURATION
      );
    });

    it("Should allow emergency unlock by admin", async function () {
      const EMERGENCY_ROLE = ethers.keccak256(
        ethers.toUtf8Bytes("EMERGENCY_ROLE")
      );
      await lpFeeHarvester.grantRole(EMERGENCY_ROLE, owner.address);

      await expect(
        lpFeeHarvester.emergencyUnlock(
          await projectToken.getAddress(),
          creator.address,
          "Security issue"
        )
      ).to.emit(lpFeeHarvester, "EmergencyUnlock");

      const lockInfo = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );
      expect(lockInfo.active).to.be.false;
    });

    it("Should reject emergency unlock from non-admin", async function () {
      await expect(
        lpFeeHarvester
          .connect(user1)
          .emergencyUnlock(
            await projectToken.getAddress(),
            creator.address,
            "Unauthorized"
          )
      ).to.be.revert(ethers);
    });

    it("Should allow pause/unpause", async function () {
      const EMERGENCY_ROLE = ethers.keccak256(
        ethers.toUtf8Bytes("EMERGENCY_ROLE")
      );
      await lpFeeHarvester.grantRole(EMERGENCY_ROLE, owner.address);

      await lpFeeHarvester.pause();

      // ✅ Create a new token for this test
      const tx2 = await tokenFactory.createToken(
        "Test Token 2",
        "TEST2",
        1_000_000_000,
        18,
        owner.address,
        defaultMetadata
      );

      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs?.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(log as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent2 = tokenFactory.interface.parseLog(event2 as any);
      const token2Address = parsedEvent2?.args.tokenAddress;

      await mockPancakeFactory.createPair(
        token2Address,
        "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"
      );

      const pair2 = await mockPancakeFactory.getPair(
        token2Address,
        "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"
      );

      const mockPair2 = await ethers.getContractAt("MockPancakePair", pair2);

      await mockPair2.mint(owner.address, ethers.parseEther("10"));
      await mockPair2.approve(
        await lpFeeHarvester.getAddress(),
        ethers.parseEther("10")
      );

      // ✅ Use the actual token address, not user1.address
      await expect(
        lpFeeHarvester.lockLP(
          token2Address, // ✅ Fixed - use real token
          await mockPair2.getAddress(),
          creator.address,
          projectInfoFi.address,
          ethers.parseEther("10"),
          DEFAULT_LOCK_DURATION
        )
      ).to.be.revertedWithCustomError(lpFeeHarvester, "EnforcedPause");

      // Unpause
      const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
      await lpFeeHarvester.grantRole(DEFAULT_ADMIN_ROLE, owner.address);
      await lpFeeHarvester.unpause();

      // Should work after unpause
      await expect(
        lpFeeHarvester.lockLP(
          token2Address, // ✅ Use real token
          await mockPair2.getAddress(),
          creator.address,
          projectInfoFi.address,
          ethers.parseEther("10"),
          DEFAULT_LOCK_DURATION
        )
      ).to.not.be.revert(ethers);
    });
  });

  describe("View Functions", function () {
    beforeEach(async function () {
      const lpAmount = ethers.parseEther("100");

      await mockPancakePair.setReserves(
        ethers.parseEther("1000"),
        ethers.parseEther("10")
      );

      await mockPancakePair.mint(owner.address, lpAmount);
      await mockPancakePair.approve(
        await lpFeeHarvester.getAddress(),
        lpAmount
      );

      await lpFeeHarvester.lockLP(
        await projectToken.getAddress(),
        await mockPancakePair.getAddress(),
        creator.address,
        projectInfoFi.address,
        lpAmount,
        DEFAULT_LOCK_DURATION
      );
    });

    it("Should return correct lock info", async function () {
      const lockInfo = await lpFeeHarvester.getLockInfo(
        await projectToken.getAddress()
      );

      expect(lockInfo.lpToken).to.equal(await mockPancakePair.getAddress());
      expect(lockInfo.creator).to.equal(creator.address);
      expect(lockInfo.projectInfoFi).to.equal(projectInfoFi.address);
      expect(lockInfo.lpAmount).to.be.gt(0);
      expect(lockInfo.active).to.be.true;
    });

    it("Should check if harvest is ready", async function () {
      let [ready, timeRemaining] = await lpFeeHarvester.canHarvest(
        await projectToken.getAddress()
      );
      expect(ready).to.be.false;
      expect(timeRemaining).to.be.gt(0);

      await ethers.provider.send("evm_increaseTime", [HARVEST_COOLDOWN]);
      await ethers.provider.send("evm_mine", []);

      [ready, timeRemaining] = await lpFeeHarvester.canHarvest(
        await projectToken.getAddress()
      );
      expect(ready).to.be.true;
      expect(timeRemaining).to.equal(0);
    });

    it("Should return platform statistics", async function () {
      const stats = await lpFeeHarvester.getPlatformStats();

      expect(stats._activeLocksCount).to.equal(1);
      expect(stats._totalValueLocked).to.be.gt(0);
      expect(stats._totalHarvests).to.equal(0);
    });

    it("Should return all locked projects", async function () {
      const projects = await lpFeeHarvester.getAllLockedProjects();

      expect(projects.length).to.equal(1);
      expect(projects[0]).to.equal(await projectToken.getAddress());
    });

    it("Should return LP value breakdown", async function () {
      const [token0Amount, token1Amount, token0, token1] =
        await lpFeeHarvester.getLPValue(await projectToken.getAddress());

      expect(token0Amount).to.be.gt(0);
      expect(token1Amount).to.be.gt(0);
      expect(token0).to.not.equal(ethers.ZeroAddress);
      expect(token1).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow admin to update platform fee address", async function () {
      const newPlatformFee = user1.address;

      await lpFeeHarvester.updatePlatformFeeAddress(newPlatformFee);

      expect(await lpFeeHarvester.platformFeeAddress()).to.equal(
        newPlatformFee
      );
    });

    it("Should reject platform fee update from non-admin", async function () {
      await expect(
        lpFeeHarvester.connect(user1).updatePlatformFeeAddress(user2.address)
      ).to.be.revert(ethers);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle multiple project locks", async function () {
      const tx = await tokenFactory.createToken(
        "Project Token 2",
        "PROJ2",
        1_000_000_000,
        18,
        owner.address,
        defaultMetadata
      );

      const receipt = await tx.wait();
      const event = receipt?.logs?.find((log: any) => {
        try {
          return (
            tokenFactory.interface.parseLog(log as any)?.name === "TokenCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = tokenFactory.interface.parseLog(event as any);
      const token2Address = parsedEvent?.args.tokenAddress;

      const projectToken2 = await ethers.getContractAt(
        "LaunchpadTokenV2",
        token2Address
      );
      await projectToken2.enableTransfers();
      // ✅ FIXED: Register second pair
      await mockPancakeFactory.createPair(
        token2Address,
        "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"
      );

      const pair2 = await mockPancakeFactory.getPair(
        token2Address,
        "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"
      );
      const mockPair2 = await ethers.getContractAt("MockPancakePair", pair2);

      const lpAmount = ethers.parseEther("100");

      await mockPair2.setReserves(
        ethers.parseEther("1000"),
        ethers.parseEther("10")
      );
      await mockPair2.mint(owner.address, lpAmount);
      await mockPair2.approve(await lpFeeHarvester.getAddress(), lpAmount);

      await lpFeeHarvester.lockLP(
        token2Address,
        await mockPair2.getAddress(),
        creator.address,
        projectInfoFi.address,
        lpAmount,
        DEFAULT_LOCK_DURATION
      );

      const stats = await lpFeeHarvester.getPlatformStats();
      expect(stats._activeLocksCount).to.equal(1);
    });

    it("Should handle harvest with minimal LP burn", async function () {
      const lpAmount = ethers.parseEther("1000");
      await owner.sendTransaction({
        to: await mockPancakeRouter.getAddress(),
        value: ethers.parseEther("100"), // Plenty of ETH for all tests
      });
      await mockPancakePair.mint(owner.address, lpAmount);
      await mockPancakePair.approve(
        await lpFeeHarvester.getAddress(),
        lpAmount
      );

      await lpFeeHarvester.lockLP(
        await projectToken.getAddress(),
        await mockPancakePair.getAddress(),
        creator.address,
        projectInfoFi.address,
        lpAmount,
        DEFAULT_LOCK_DURATION
      );

      await mockPancakePair.setReserves(
        ethers.parseEther("1001"),
        ethers.parseEther("10.01")
      );

      await ethers.provider.send("evm_increaseTime", [HARVEST_COOLDOWN]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        lpFeeHarvester.harvestFees(await projectToken.getAddress())
      ).to.not.be.revert(ethers);
    });
  });
});
