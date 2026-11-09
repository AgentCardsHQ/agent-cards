// Runs only with FORK=1 (FORK=1 npx hardhat test test/staked-duels-fork.test.js): StakedDuels' seed read against a live
// copy of BSC mainnet. Past 256 blocks the seed comes from the chain's EIP-2935 history contract; here that is BSC's own,
// its code and every hash it holds as mainnet has them at the fork block. Hardhat doesn't run EIP-2935's write at the
// start of each block it mines itself, so for blocks mined here the test writes what the chain would (block n's hash at
// slot n % 8191); every block from before the fork is read from mainnet's own record.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

const HISTORY = "0x0000F90827F1C53a10cb7A02335B175320002935";
// EIP-2935's history contract as the EIP gives it (HISTORY_SERVE_WINDOW 8191 = 0x1fff)
const EIP2935_CODE = "0x3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500";
const SETTLE_WINDOW = 7000;
const STAKE = ethers.parseEther("0.0015");

const hashOf = async (n) => (await ethers.provider.getBlock(n)).hash;
const seedOf = async (lockBlock) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32[]"], [[await hashOf(lockBlock), await hashOf(lockBlock + 1), await hashOf(lockBlock + 2)]]));
/** What the chain writes at the start of each block, for the blocks Hardhat mined here (from the fork block on). */
async function writeLikeTheChain(from, blocks = []) {
  const head = await ethers.provider.getBlockNumber();
  const all = [...blocks];
  for (let n = from; n <= head; n++) all.push(n);
  for (const n of all) await network.provider.send("hardhat_setStorageAt", [HISTORY, ethers.toQuantity(n % 8191), await hashOf(n)]);
}

describe("fork: StakedDuels and BSC mainnet's block-hash history", function () {
  before(function () {
    if (!process.env.FORK) this.skip();
  });

  it("mainnet runs EIP-2935's history contract, and StakedDuels reads mainnet's real hashes through it, inside its window only", async () => {
    expect(await ethers.provider.getCode(HISTORY)).to.equal(EIP2935_CODE);
    const fork = await ethers.provider.getBlockNumber(); // every block up to this one is mainnet's
    const cards = await ethers.deployContract("MockCards");
    const probe = await ethers.deployContract("StakedDuelsProbe", [await cards.getAddress()]); // the constructor finds HISTORY
    await writeLikeTheChain(fork);
    const now = Number(await probe.blockNumber()); // the block a call runs in

    // HISTORY as StakedDuels calls it, against the hashes the mainnet node reports
    for (const back of [300, 1000, 5000, 7000, 8000]) expect(await probe.historyAt(fork - back), `${back} blocks before the fork`).to.equal(await hashOf(fork - back));
    expect(await probe.historyAt(now - 8192)).to.equal(ethers.ZeroHash); // past the 8,191 it serves: 0, not an error
    expect(await probe.historyAt(now)).to.equal(ethers.ZeroHash); // not mined yet

    // the seed of a duel locked 5,000 blocks ago (mainnet blocks), and its window's edge
    for (const back of [400, 5000, SETTLE_WINDOW - 10]) {
      const lockBlock = now - back;
      expect(await probe.seedAt(lockBlock), `locked ${back} blocks ago`).to.equal(await seedOf(lockBlock));
    }
    expect(await probe.seedAt(now - SETTLE_WINDOW)).to.equal(await seedOf(now - SETTLE_WINDOW)); // the last block settle() takes
    expect(await probe.seedAt(now - SETTLE_WINDOW - 1)).to.equal(ethers.ZeroHash); // mainnet still has it; the window is gone
  });

  it("a duel on the fork settles through mainnet's history contract 300 blocks after its lock, to the wei, and another refunds once its window is gone", async () => {
    const [owner, treasury, server, a, b] = await ethers.getSigners();
    const fork = await ethers.provider.getBlockNumber();
    const cards = await ethers.deployContract("MockCards");
    const duels = await ethers.deployContract("StakedDuels", [owner.address, await cards.getAddress(), treasury.address, server.address, STAKE, ethers.parseEther("0.03"), 100, ethers.parseEther("1")]);
    await cards.mint(a.address, 7);
    await cards.mint(b.address, 8);
    for (const p of [a, b]) await duels.connect(p).deposit({ value: STAKE * 2n });
    const domain = { name: "StakedDuels", version: "1", chainId: 56, verifyingContract: await duels.getAddress() };
    const INTENT = { Intent: [{ name: "player", type: "address" }, { name: "cardId", type: "uint256" }, { name: "stake", type: "uint256" }, { name: "opponent", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint64" }] };
    const MATCH = { Match: [{ name: "intentA", type: "bytes32" }, { name: "intentB", type: "bytes32" }, { name: "terms", type: "bytes32" }] };
    const SETTLE = { Settle: [{ name: "duelId", type: "uint256" }, { name: "winner", type: "address" }, { name: "seed", type: "bytes32" }] };
    let nonce = 0;
    const form = async () => {
      const expiry = (await ethers.provider.getBlock("latest")).timestamp + 600;
      const [ia, ib] = [[a, 7], [b, 8]].map(([w, cardId]) => ({ player: w.address, cardId, stake: STAKE, opponent: ethers.ZeroAddress, nonce: nonce++, expiry }));
      const terms = ethers.id(`fork duel ${nonce}`);
      const matchSig = await server.signTypedData(domain, MATCH, { intentA: await duels.intentDigest(ia), intentB: await duels.intentDigest(ib), terms });
      const rc = await (await duels.formDuel(ia, await a.signTypedData(domain, INTENT, ia), ib, await b.signTypedData(domain, INTENT, ib), terms, matchSig)).wait();
      const ev = rc.logs.map((l) => duels.interface.parseLog(l)).find((l) => l?.name === "DuelFormed");
      return { id: ev.args.duelId, lockBlock: Number(ev.args.lockBlock) };
    };

    const one = await form();
    await mine(300); // blockhash() no longer has its first seed block
    await writeLikeTheChain(fork);
    const seed = await duels.seedOf(one.id);
    expect(seed).to.equal(await seedOf(one.lockBlock));
    const sig = await server.signTypedData(domain, SETTLE, { duelId: one.id, winner: a.address, seed });
    const fee = ((STAKE * 750n) / 10000n) * 2n;
    await writeLikeTheChain(fork);
    await expect(duels.settle(one.id, a.address, sig)).to.emit(duels, "Settled").withArgs(one.id, a.address, seed, STAKE * 2n - fee, fee);
    expect(await duels.balanceOf(a.address)).to.equal(STAKE + STAKE * 2n - fee);
    expect(await duels.balanceOf(b.address)).to.equal(STAKE);
    expect(await duels.treasuryBalance()).to.equal(fee);

    const two = await form();
    await expect(duels.refundTimeout(two.id)).to.be.revertedWithCustomError(duels, "TimeoutNotReached");
    await mine(two.lockBlock + SETTLE_WINDOW - (await ethers.provider.getBlockNumber()));
    await expect(duels.refundTimeout(two.id)).to.emit(duels, "Refunded"); // lockBlock + SETTLE_WINDOW + 1
    expect(await duels.balanceOf(a.address)).to.equal(STAKE * 3n - fee); // each side's stake of duel two back
    expect(await duels.balanceOf(b.address)).to.equal(STAKE);
  });
});
