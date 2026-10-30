const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 86400;
const WINDOW = 90 * DAY;
const BNB = (s) => ethers.parseEther(s);
const TIMELOCK = 48 * 3600;
let POOL_AT; // the pool deployed by the test, which every leaf is bound to

// the worker's own tree code (worker/src/merkle.js), so the proofs the server hands out are the ones checked here; the
// public repository keeps a copy of it at lib/merkle.js
const MERKLE = ["worker/src/merkle.js", "lib/merkle.js"].map((p) => path.join(__dirname, "..", p)).find((p) => fs.existsSync(p));
let M;
before(async () => {
  M = await import(pathToFileURL(MERKLE).href);
});

async function deploy() {
  const [owner, treasury, a, b, c, other] = await ethers.getSigners();
  const pool = await ethers.deployContract("RewardPool", [owner.address, treasury.address]);
  POOL_AT = await pool.getAddress();
  return { owner, treasury, a, b, c, other, pool };
}

/** A season's payouts as the worker builds them, bound to the pool and the season: the root, the total to fund and each
 *  wallet's proof. */
function payouts(list, season = 1, pool = POOL_AT) {
  const tree = M.merkleTree(list.map(([w, amount]) => ({ wallet: w.address ?? w, amount })), { pool, season });
  const proof = (w) => tree.proofs.get(String(w.address ?? w).toLowerCase());
  return { root: tree.root, total: list.reduce((s, [, x]) => s + x, 0n), proof };
}

describe("RewardPool", () => {
  it("pays each wallet in the root its amount once, straight from the season's deposit", async () => {
    const { owner, a, b, c, pool } = await deploy();
    const p = payouts([[a, BNB("0.5")], [b, BNB("0.25")], [c, BNB("0.05")]]);
    const tx = await pool.connect(owner).fund(1, p.root, { value: p.total });
    const ends = (await ethers.provider.getBlock((await tx.wait()).blockNumber)).timestamp + WINDOW;
    await expect(tx).to.emit(pool, "Funded").withArgs(1, p.root, p.total, ends);
    const s = await pool.seasons(1);
    expect([s.root, s.funded, s.claimed, s.claimEnds, s.swept]).to.deep.equal([p.root, p.total, 0n, BigInt(ends), false]);

    await expect(pool.connect(a).claim(1, BNB("0.5"), p.proof(a))).to.changeEtherBalances([a, pool], [BNB("0.5"), -BNB("0.5")]);
    await expect(pool.connect(b).claim(1, BNB("0.25"), p.proof(b))).to.emit(pool, "Claimed").withArgs(1, b.address, BNB("0.25"));
    await expect(pool.connect(a).claim(1, BNB("0.5"), p.proof(a))).to.be.revertedWithCustomError(pool, "AlreadyClaimed");
    expect(await pool.claimed(1, a.address)).to.equal(true);
    expect(await pool.claimed(1, c.address)).to.equal(false);
    expect((await pool.seasons(1)).claimed).to.equal(BNB("0.75"));
    expect(await pool.leaf(1, a.address, BNB("0.5"))).to.equal(M.leafOf({ pool: POOL_AT, season: 1 }, a.address, BNB("0.5")));
  });

  it("refuses a wrong amount, someone else's proof, an unknown wallet and an unfunded season", async () => {
    const { owner, a, b, other, pool } = await deploy();
    const p = payouts([[a, BNB("1")], [b, BNB("2")]], 3);
    await pool.connect(owner).fund(3, p.root, { value: p.total });
    await expect(pool.connect(a).claim(3, BNB("2"), p.proof(a))).to.be.revertedWithCustomError(pool, "BadProof");
    await expect(pool.connect(a).claim(3, BNB("2"), p.proof(b))).to.be.revertedWithCustomError(pool, "BadProof");
    await expect(pool.connect(other).claim(3, BNB("1"), p.proof(a))).to.be.revertedWithCustomError(pool, "BadProof");
    await expect(pool.connect(a).claim(4, BNB("1"), p.proof(a))).to.be.revertedWithCustomError(pool, "NotFunded");
    // a single-wallet season: the root is the leaf and the proof is empty
    const solo = payouts([[a, BNB("0.3")]], 5);
    expect(solo.proof(a)).to.deep.equal([]);
    await pool.connect(owner).fund(5, solo.root, { value: solo.total });
    await expect(pool.connect(a).claim(5, BNB("0.3"), [])).to.changeEtherBalance(a, BNB("0.3"));
  });

  it("lets only the owner fund, once per season, with BNB and a root", async () => {
    const { owner, a, other, pool } = await deploy();
    const p = payouts([[a, BNB("1")]]);
    await expect(pool.connect(other).fund(1, p.root, { value: p.total })).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    await expect(pool.connect(owner).fund(1, ethers.ZeroHash, { value: p.total })).to.be.revertedWithCustomError(pool, "BadFunding");
    await expect(pool.connect(owner).fund(1, p.root)).to.be.revertedWithCustomError(pool, "BadFunding");
    await pool.connect(owner).fund(1, p.root, { value: p.total });
    // final: no second deposit, no new root, nothing to top up or take back
    await expect(pool.connect(owner).fund(1, p.root, { value: 1n })).to.be.revertedWithCustomError(pool, "AlreadyFunded");
    // plain BNB sent to the pool is refused: every wei in it belongs to a season
    await expect(owner.sendTransaction({ to: await pool.getAddress(), value: 1n })).to.be.reverted;
  });

  it("never lets a season's claims reach another season's BNB", async () => {
    const { owner, a, b, pool } = await deploy();
    // season 1's root promises more than was deposited (a mistaken deposit): season 2's BNB stays out of reach
    const one = payouts([[a, BNB("1")], [b, BNB("1")]]);
    await pool.connect(owner).fund(1, one.root, { value: BNB("1.5") });
    const two = payouts([[a, BNB("4")]], 2);
    await pool.connect(owner).fund(2, two.root, { value: two.total });
    await pool.connect(a).claim(1, BNB("1"), one.proof(a));
    await expect(pool.connect(b).claim(1, BNB("1"), one.proof(b))).to.be.revertedWithCustomError(pool, "PoolShort");
    await expect(pool.connect(a).claim(2, BNB("4"), two.proof(a))).to.changeEtherBalance(a, BNB("4"));
    expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(BNB("0.5"));
  });

  it("closes claims after 90 days; only then can anyone sweep what is left, to the treasury, once", async () => {
    const { owner, treasury, a, b, other, pool } = await deploy();
    const p = payouts([[a, BNB("0.6")], [b, BNB("0.4")]], 7);
    await pool.connect(owner).fund(7, p.root, { value: p.total });
    const { claimEnds } = await pool.seasons(7);
    await pool.connect(a).claim(7, BNB("0.6"), p.proof(a));
    // while the window is open nobody can take the claimable BNB, the owner included
    await expect(pool.connect(owner).sweep(7)).to.be.revertedWithCustomError(pool, "StillOpen");
    await expect(pool.connect(other).sweep(7)).to.be.revertedWithCustomError(pool, "StillOpen");
    await time.setNextBlockTimestamp(claimEnds); // the window's last second still takes a claim
    await expect(pool.connect(b).claim(7, BNB("0.4"), p.proof(b))).to.changeEtherBalance(b, BNB("0.4"));
    const late = payouts([[a, BNB("1")], [b, BNB("1")]], 8);
    await pool.connect(owner).fund(8, late.root, { value: late.total });
    const ends8 = (await pool.seasons(8)).claimEnds;
    await pool.connect(a).claim(8, BNB("1"), late.proof(a));
    await time.setNextBlockTimestamp(ends8);
    await expect(pool.connect(owner).sweep(8)).to.be.revertedWithCustomError(pool, "StillOpen"); // not even in the last second
    await time.increaseTo(ends8 + 1n);
    await expect(pool.connect(b).claim(8, BNB("1"), late.proof(b))).to.be.revertedWithCustomError(pool, "ClaimClosed");
    // anyone may sweep once the window has closed: the destination is fixed, so a lost owner key strands nothing
    await expect(pool.connect(other).sweep(8)).to.changeEtherBalances([treasury, pool], [BNB("1"), -BNB("1")]);
    await expect(pool.connect(owner).sweep(8)).to.be.revertedWithCustomError(pool, "AlreadySwept");
    await expect(pool.connect(owner).sweep(7)).to.emit(pool, "Swept").withArgs(7, treasury.address, 0n); // all claimed
    await expect(pool.connect(owner).sweep(9)).to.be.revertedWithCustomError(pool, "NotFunded");
    expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(0n);
  });

  it("binds each leaf to this pool and its season: the same list funded again under another season pays nobody", async () => {
    const { owner, a, b, pool } = await deploy();
    const one = payouts([[a, BNB("1")], [b, BNB("1")]], 1);
    await pool.connect(owner).fund(1, one.root, { value: one.total });
    await pool.connect(owner).fund(2, one.root, { value: one.total }); // the owner's mistake: season 1's root once more
    await expect(pool.connect(a).claim(1, BNB("1"), one.proof(a))).to.changeEtherBalance(a, BNB("1"));
    await expect(pool.connect(a).claim(2, BNB("1"), one.proof(a))).to.be.revertedWithCustomError(pool, "BadProof"); // not twice
    expect(payouts([[a, BNB("1")], [b, BNB("1")]], 2).root).to.not.equal(one.root);
    const elsewhere = await ethers.deployContract("RewardPool", [owner.address, owner.address]);
    expect(payouts([[a, BNB("1")]], 1, await elsewhere.getAddress()).root).to.not.equal(payouts([[a, BNB("1")]], 1).root);
  });

  it("can't be re-entered from a claim, and a refused payment leaves the claim open", async () => {
    const { owner, pool } = await deploy();
    const claimer = await ethers.deployContract("PoolClaimer", [await pool.getAddress()]);
    const at = await claimer.getAddress();
    const p = payouts([[at, BNB("1")], [owner.address, BNB("1")]]);
    await pool.connect(owner).fund(1, p.root, { value: p.total });
    await claimer.setRefuse(true);
    await expect(claimer.claim(1, BNB("1"), p.proof(at))).to.be.revertedWithCustomError(pool, "PaymentFailed");
    expect(await pool.claimed(1, at)).to.equal(false);
    await claimer.setRefuse(false);
    await expect(claimer.claim(1, BNB("1"), p.proof(at))).to.changeEtherBalance(claimer, BNB("1"));
    expect(await claimer.reentered()).to.equal(false); // the claim from inside the payment was refused
    expect((await pool.seasons(1)).claimed).to.equal(BNB("1"));
  });

  it("keeps a treasury fixed at deploy, moves ownership in two steps 48 hours apart and never renounces it", async () => {
    const { owner, treasury, a, other, pool } = await deploy();
    expect(await pool.treasury()).to.equal(treasury.address);
    expect(await pool.CLAIM_WINDOW()).to.equal(BigInt(WINDOW));
    await expect(pool.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(pool, "RenounceDisabled");
    // a tricked signature can't hand the pool over at once: the new owner may accept only after the wait
    const started = await pool.connect(owner).transferOwnership(other.address);
    const eta = BigInt((await ethers.provider.getBlock((await started.wait()).blockNumber)).timestamp) + BigInt(TIMELOCK);
    await expect(started).to.emit(pool, "OwnershipProposed").withArgs(other.address, eta);
    expect([await pool.owner(), await pool.ownerEta()]).to.deep.equal([owner.address, eta]);
    await expect(pool.connect(other).acceptOwnership()).to.be.revertedWithCustomError(pool, "NotReady");
    await pool.connect(owner).transferOwnership(ethers.ZeroAddress); // cancelled during the wait: nothing to accept, even later
    await time.increase(TIMELOCK);
    await expect(pool.connect(other).acceptOwnership()).to.be.revertedWithCustomError(pool, "NotReady");
    await pool.connect(owner).transferOwnership(other.address);
    await time.increase(TIMELOCK - 10);
    await expect(pool.connect(other).acceptOwnership()).to.be.revertedWithCustomError(pool, "NotReady");
    await time.increase(10);
    await expect(pool.connect(a).acceptOwnership()).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount"); // only the pending owner
    await pool.connect(other).acceptOwnership();
    expect([await pool.owner(), await pool.ownerEta()]).to.deep.equal([other.address, 0n]);
    await expect(ethers.deployContract("RewardPool", [owner.address, ethers.ZeroAddress])).to.be.revertedWithCustomError(pool, "ZeroAddress");
    // a treasury that refuses the sweep keeps the BNB in the pool, swept flag untouched
    const refusing = await ethers.deployContract("RejectingTreasury");
    const stuck = await ethers.deployContract("RewardPool", [owner.address, await refusing.getAddress()]);
    const p = payouts([[a, BNB("1")]], 1, await stuck.getAddress());
    await stuck.connect(owner).fund(1, p.root, { value: p.total });
    await time.increase(WINDOW + 1);
    await expect(stuck.connect(owner).sweep(1)).to.be.revertedWithCustomError(stuck, "PaymentFailed");
    expect((await stuck.seasons(1)).swept).to.equal(false);
  });

  it("checks the worker's proofs for a big season and reports gas", async () => {
    const { owner, pool } = await deploy();
    const list = Array.from({ length: 300 }, (_, i) => [ethers.Wallet.createRandom().address, BNB("0.001") * BigInt(i + 1)]);
    const p = payouts(list, 2);
    await pool.connect(owner).fund(2, p.root, { value: p.total });
    const [w, amount] = list[137];
    await ethers.provider.send("hardhat_setBalance", [w, "0x16345785D8A0000"]);
    await ethers.provider.send("hardhat_impersonateAccount", [w]);
    const signer = await ethers.getSigner(w);
    const proof = p.proof(w);
    expect(M.verifyProof(proof, p.root, { pool: POOL_AT, season: 2 }, w, amount)).to.equal(true);
    const rc = await (await pool.connect(signer).claim(2, amount, proof)).wait();
    console.log(`      claim gas with ${list.length} wallets (proof of ${proof.length}): ${rc.gasUsed}`);
    const { root: r2 } = M.merkleTree([...list].reverse().map(([wallet, x]) => ({ wallet, amount: x })), { pool: POOL_AT, season: 2 });
    expect(r2).to.equal(p.root); // the same payouts in any order give the same root
  });
});
