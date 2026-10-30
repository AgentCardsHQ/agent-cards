require("@nomicfoundation/hardhat-toolbox");

// FORK=1 npx hardhat test test/fork.test.js runs against a live copy of BSC mainnet
const fork = process.env.FORK ? { forking: { url: "https://bsc-rpc.publicnode.com" }, chainId: 56 } : {};

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" },
  },
  networks: { hardhat: { ...fork, chains: { 56: { hardforkHistory: { cancun: 0 } } } } },
};
