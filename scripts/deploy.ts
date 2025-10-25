// scripts/deploy.ts
import { network } from "hardhat";

const { ethers } = await network.connect();
import fs from "fs";

import type { Signer } from "ethers";
import type { Contract, ContractFactory } from "ethers";

// Color codes for console output
const colors: Record<string, string> = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message: string, color: string = colors.reset): void {
  console.log(`${color}${message}${colors.reset}`);
}

function logSection(title: string): void {
  console.log("\n" + "=".repeat(60));
  log(title, colors.bright + colors.cyan);
  console.log("=".repeat(60));
}

// Helper to safely get deployed contract address (supports different hardhat/ethers versions)
async function resolveAddress(contract: any): Promise<string> {
  if (!contract) return "";
  try {
    if (typeof contract.getAddress === "function") {
      const val = await contract.getAddress();
      if (typeof val === "string") return val;
      // Some variants return Promise-like objects
      return String(val);
    }
  } catch (e) {
    // ignore and try fallback
  }
  return (contract.address as string) ?? "";
}

async function main(): Promise<void> {
  const signers: Signer[] = await ethers.getSigners();
  const deployer: Signer = signers[0];
  const deployerAddress: string = await deployer.getAddress();

  const networkName: string =
    (network as any).name ??
    String(((await ethers.provider.getNetwork())).chainId ?? "local");

  logSection("🚀 SAFUPAD DEPLOYMENT SCRIPT");
  log(`Deploying from: ${deployerAddress}`, colors.green);
  log(
    `Balance: ${ethers.formatEther(
      await ethers.provider.getBalance(deployerAddress)
    )} BNB`,
    colors.green
  );
  log(`Network: ${networkName}`, colors.blue);

  // ============================================
  // CONFIGURATION - UPDATE THESE VALUES
  // ============================================
  const config: {
    priceFeed: string;
    pancakeRouter: string;
    pancakeFactory: string;
    platformFeeAddress: string;
    academyFeeAddress: string;
    infoFiAddress: string;
    adminAddress: string;
  } = {
    priceFeed: "0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526", // BSC Mainnet
    pancakeRouter: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1", // BSC Mainnet
    pancakeFactory: "0x6725F303b657a9451d8BA641348b6761A6CC7a17", // BSC Mainnet
    platformFeeAddress: deployerAddress,
    academyFeeAddress: deployerAddress,
    infoFiAddress: deployerAddress,
    adminAddress: deployerAddress,
  };

  logSection("📋 CONFIGURATION");
  console.log(config);

  const deployedContracts: Record<string, string> = {};
  const txHashes: Record<string, string> = {};

  // ============================================
  // 1. DEPLOY PRICE ORACLE
  // ============================================
  logSection("1️⃣  Deploying PriceOracle");

  const PriceOracle: ContractFactory = await ethers.getContractFactory(
    "PriceOracle"
  );
  const priceOracle = await PriceOracle.deploy(config.priceFeed);
  if (typeof (priceOracle as any).waitForDeployment === "function") {
    await (priceOracle as any).waitForDeployment();
  }

  deployedContracts.priceOracle = await resolveAddress(priceOracle);
  log(
    `✅ PriceOracle deployed to: ${deployedContracts.priceOracle}`,
    colors.green
  );

  if (typeof (priceOracle as any).getBNBPrice === "function") {
    try {
      const bnbPriceRaw = await (priceOracle as any).getBNBPrice();
      try {
        log(
          `   Current BNB Price: $${ethers.formatUnits(bnbPriceRaw as any, 8)}`,
          colors.yellow
        );
      } catch {
        log(`   Current BNB Price: ${String(bnbPriceRaw)}`, colors.yellow);
      }
    } catch (e) {
      // ignore
    }
  }

  // ============================================
  // 2. DEPLOY TOKEN FACTORY
  // ============================================
  logSection("2️⃣  Deploying TokenFactoryV2");

  const TokenFactoryV2: ContractFactory = await ethers.getContractFactory(
    "TokenFactoryV2"
  );
  const tokenFactory = await TokenFactoryV2.deploy();
  if (typeof (tokenFactory as any).waitForDeployment === "function") {
    await (tokenFactory as any).waitForDeployment();
  }

  deployedContracts.tokenFactory = await resolveAddress(tokenFactory);
  log(
    `✅ TokenFactoryV2 deployed to: ${deployedContracts.tokenFactory}`,
    colors.green
  );

  // ============================================
  // 3. DEPLOY LP FEE HARVESTER
  // ============================================
  logSection("3️⃣  Deploying LPFeeHarvester");

  const LPFeeHarvester = await ethers.getContractFactory(
    "LPFeeHarvester"
  );
  const lpFeeHarvester = await LPFeeHarvester.deploy(
    config.pancakeRouter,
    config.pancakeFactory,
    config.platformFeeAddress,
    config.adminAddress
  );
  if (typeof (lpFeeHarvester).waitForDeployment === "function") {
    await (lpFeeHarvester).waitForDeployment();
  }

  deployedContracts.lpFeeHarvester = await resolveAddress(lpFeeHarvester);
  log(
    `✅ LPFeeHarvester deployed to: ${deployedContracts.lpFeeHarvester}`,
    colors.green
  );

  // ============================================
  // 4. DEPLOY BONDING CURVE DEX
  // ============================================
  logSection("4️⃣  Deploying BondingCurveDEX");

  const BondingCurveDEX: ContractFactory = await ethers.getContractFactory(
    "BondingCurveDEX"
  );
  const bondingCurveDEX = await BondingCurveDEX.deploy(
    config.platformFeeAddress,
    config.academyFeeAddress,
    config.infoFiAddress,
    deployedContracts.priceOracle,
    config.adminAddress,
    config.pancakeRouter,
    config.pancakeFactory,
    deployedContracts.lpFeeHarvester
  );
  if (typeof (bondingCurveDEX as any).waitForDeployment === "function") {
    await (bondingCurveDEX as any).waitForDeployment();
  }

  deployedContracts.bondingCurveDEX = await resolveAddress(bondingCurveDEX);
  log(
    `✅ BondingCurveDEX deployed to: ${deployedContracts.bondingCurveDEX}`,
    colors.green
  );

  // ============================================
  // 5. DEPLOY LAUNCHPAD MANAGER
  // ============================================
  logSection("5️⃣  Deploying LaunchpadManagerV3");

  const LaunchpadManagerV3: ContractFactory = await ethers.getContractFactory(
    "LaunchpadManagerV3"
  );
  const launchpadManager = await LaunchpadManagerV3.deploy(
    deployedContracts.tokenFactory,
    deployedContracts.bondingCurveDEX,
    config.pancakeRouter,
    deployedContracts.priceOracle,
    config.infoFiAddress,
    deployedContracts.lpFeeHarvester,
    config.pancakeFactory
  );
  if (typeof (launchpadManager as any).waitForDeployment === "function") {
    await (launchpadManager as any).waitForDeployment();
  }

  deployedContracts.launchpadManager = await resolveAddress(launchpadManager);
  log(
    `✅ LaunchpadManagerV3 deployed to: ${deployedContracts.launchpadManager}`,
    colors.green
  );

  // ============================================
  // 6. SETUP ROLES & PERMISSIONS
  // ============================================
  logSection("6️⃣  Setting up Roles & Permissions");

  log("→ Granting MANAGER_ROLE to LaunchpadManager on BondingCurveDEX...");
  const MANAGER_ROLE: string =
    (typeof (bondingCurveDEX as any).MANAGER_ROLE === "function"
      ? await (bondingCurveDEX as any).MANAGER_ROLE()
      : (bondingCurveDEX as any).MANAGER_ROLE) ?? "";
  if (MANAGER_ROLE) {
    const tx: any = await (bondingCurveDEX as any).grantRole(
      MANAGER_ROLE,
      deployedContracts.launchpadManager
    );
    await tx.wait?.();
    log(`✅ MANAGER_ROLE granted`, colors.green);
  } else {
    log(`⚠️ Could not resolve MANAGER_ROLE on BondingCurveDEX`, colors.yellow);
  }

  log("→ Granting MANAGER_ROLE to LaunchpadManager on LPFeeHarvester...");
  const HARVESTER_MANAGER_ROLE: string =
    (typeof (lpFeeHarvester as any).MANAGER_ROLE === "function"
      ? await (lpFeeHarvester as any).MANAGER_ROLE()
      : (lpFeeHarvester as any).MANAGER_ROLE) ?? "";
  if (HARVESTER_MANAGER_ROLE) {
    const tx2: any = await (lpFeeHarvester as any).grantRole(
      HARVESTER_MANAGER_ROLE,
      deployedContracts.launchpadManager
    );
    await tx2.wait?.();
    log(`✅ MANAGER_ROLE granted`, colors.green);
  } else {
    log(`⚠️ Could not resolve MANAGER_ROLE on LPFeeHarvester`, colors.yellow);
  }

  // ============================================
  // 7. VERIFICATION
  // ============================================
  logSection("7️⃣  Verifying Deployment");

  const hasManagerRole: boolean = !!(await (bondingCurveDEX as any).hasRole?.(
    MANAGER_ROLE,
    deployedContracts.launchpadManager
  ));
  log(
    `LaunchpadManager has MANAGER_ROLE on BondingCurveDEX: ${
      hasManagerRole ? "✅" : "❌"
    }`,
    hasManagerRole ? colors.green : colors.red
  );

  const hasHarvesterRole: boolean = !!(await (lpFeeHarvester as any).hasRole?.(
    HARVESTER_MANAGER_ROLE,
    deployedContracts.launchpadManager
  ));
  log(
    `LaunchpadManager has MANAGER_ROLE on LPFeeHarvester: ${
      hasHarvesterRole ? "✅" : "❌"
    }`,
    hasHarvesterRole ? colors.green : colors.red
  );

  const platformStats: any =
    typeof (lpFeeHarvester as any).getPlatformStats === "function"
      ? await (lpFeeHarvester as any).getPlatformStats()
      : (lpFeeHarvester as any).getPlatformStats;
  log(
    `LPFeeHarvester initialized: Total Value Locked = ${
      platformStats?._totalValueLocked ?? "unknown"
    }`,
    colors.yellow
  );

  // ============================================
  // 8. DEPLOYMENT SUMMARY
  // ============================================
  logSection("🎉 DEPLOYMENT COMPLETE!");

  console.log("\n📝 CONTRACT ADDRESSES:");
  console.log("━".repeat(60));
  Object.entries(deployedContracts).forEach(([name, address]) => {
    log(`${name.padEnd(25)} : ${address}`, colors.bright);
  });

  console.log("\n🔗 BLOCK EXPLORERS:");
  console.log("━".repeat(60));
  const explorerBase: string =
    networkName === "bsc"
      ? "https://bscscan.com/address/"
      : "https://testnet.bscscan.com/address/";

  Object.entries(deployedContracts).forEach(([name, address]) => {
    console.log(`${name.padEnd(25)} : ${explorerBase}${address}`);
  });

  // ============================================
  // 9. SAVE DEPLOYMENT INFO
  // ============================================
  logSection("💾 Saving Deployment Info");

  const deploymentInfo: {
    network: string;
    chainId: bigint;
    deployer: string;
    timestamp: string;
    contracts: Record<string, string>;
    config: typeof config;
  } = {
    network: networkName,
    chainId: (await ethers.provider.getNetwork()).chainId,
    deployer: deployerAddress,
    timestamp: new Date().toISOString(),
    contracts: deployedContracts,
    config: config,
  };

  const filename: string = `deployments/${networkName}-${Date.now()}.json`;
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(deploymentInfo, null, 2));

  log(`✅ Deployment info saved to: ${filename}`, colors.green);

  // ============================================
  // 10. VERIFICATION COMMANDS
  // ============================================
  logSection("🔍 Contract Verification Commands");

  console.log("\nRun these commands to verify on BSCScan:\n");

  log(
    `npx hardhat verify --network ${networkName} ${deployedContracts.priceOracle} \"${config.priceFeed}\"`,
    colors.yellow
  );

  log(
    `npx hardhat verify --network ${networkName} ${deployedContracts.tokenFactory}`,
    colors.yellow
  );

  log(
    `npx hardhat verify --network ${networkName} ${deployedContracts.lpFeeHarvester} \"${config.pancakeRouter}\" \"${config.pancakeFactory}\" \"${config.platformFeeAddress}\" \"${config.adminAddress}\"`,
    colors.yellow
  );

  log(
    `npx hardhat verify --network ${networkName} ${deployedContracts.bondingCurveDEX} \"${config.platformFeeAddress}\" \"${config.academyFeeAddress}\" \"${config.infoFiAddress}\" \"${deployedContracts.priceOracle}\" \"${config.adminAddress}\" \"${config.pancakeRouter}\" \"${config.pancakeFactory}\" \"${deployedContracts.lpFeeHarvester}\"`,
    colors.yellow
  );

  log(
    `npx hardhat verify --network ${networkName} ${deployedContracts.launchpadManager} \"${deployedContracts.tokenFactory}\" \"${deployedContracts.bondingCurveDEX}\" \"${config.pancakeRouter}\" \"${deployedContracts.priceOracle}\" \"${config.infoFiAddress}\" \"${deployedContracts.lpFeeHarvester}\" \"${config.pancakeFactory}\"`,
    colors.yellow
  );

  // ============================================
  // 11. NEXT STEPS
  // ============================================
  logSection("📚 NEXT STEPS");

  console.log(`
1. ✅ Verify all contracts on BSCScan (commands above)
2. 🔐 Transfer admin roles to multisig if needed
3. 🧪 Test create launch on testnet first
4. 💰 Fund contracts with initial liquidity if needed
5. 🌐 Update frontend with contract addresses
6. 📊 Set up monitoring and alerts
7. 🎨 Update documentation with addresses

💡 TIP: Keep the deployment info JSON file safe - it contains all addresses!
  `);

  logSection("✨ DEPLOYMENT SCRIPT FINISHED");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
