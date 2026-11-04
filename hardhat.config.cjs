// Contract test harness. Hardhat + ethers are dev-only deps (npm registry).
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

module.exports = {
  solidity: { version: "0.8.26", settings: { optimizer: { enabled: true, runs: 200 } } },
  paths: { sources: "./contracts", tests: "./test", cache: "./.hh-cache", artifacts: "./.hh-artifacts" },
};
