require("@nomicfoundation/hardhat-toolbox");
const fs = require("fs");

// FORK=1 npx hardhat test test/fork.test.js runs against a live copy of BSC mainnet
const fork = process.env.FORK ? { forking: { url: "https://bsc-rpc.publicnode.com" }, chainId: 56 } : {};

// .env (git-ignored) may hold TESTNET_DEPLOYER_KEY, the throwaway deployer of the public testnet copy
// (scripts/deploy-testnet.js), and ETHERSCAN_API_KEY, for `hardhat verify` on BscScan
const env = Object.fromEntries(
  (fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "")
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { ...fork, chains: { 56: { hardforkHistory: { cancun: 0 } } } },
    bscTestnet: {
      url: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      accounts: env.TESTNET_DEPLOYER_KEY ? [env.TESTNET_DEPLOYER_KEY] : [],
    },
  },
  etherscan: { apiKey: env.ETHERSCAN_API_KEY || "" },
  sourcify: { enabled: false },
};
