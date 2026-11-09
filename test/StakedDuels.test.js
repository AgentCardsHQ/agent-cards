// StakedDuels: two Agent Cards' holders deposit once, then duel many times with no new approval and no gas of
// their own (two off-chain-signed Intents get locked into a duel by one relayed transaction); the result is bound
// to a block-hash seed this contract reads itself (blockhash for 256 blocks, then the chain's EIP-2935 history, for
// SETTLE_WINDOW blocks), attested by the server, with a no-signature refund once that window is gone, or after 24
// hours, if settlement never comes. A draw is a settle with winner == address(0): each side's stake back at once.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

const BNB = (s) => ethers.parseEther(s);
const TIMELOCK = 48 * 3600;
const TIMEOUT = 24 * 3600;
const STAKE = BNB("0.0015");
const MAX_BALANCE = BNB("0.03");
const MAX_OPEN_DUELS = 100;
const MAX_LOCKED_VALUE = BNB("1");
const ZERO = "0x0000000000000000000000000000000000000000";
const [TREASURY, SIGNER] = [0, 1];
const [NONE, LOCKED, SETTLED, REFUNDED] = [0, 1, 2, 3];

const INTENT_TYPES = {
  Intent: [
    { name: "player", type: "address" }, { name: "cardId", type: "uint256" }, { name: "stake", type: "uint256" },
    { name: "opponent", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint64" },
  ],
};
const SETTLE_TYPES = {
  Settle: [
    { name: "duelId", type: "uint256" }, { name: "winner", type: "address" }, { name: "seed", type: "bytes32" },
  ],
};
const MATCH_TYPES = {
  Match: [
    { name: "intentA", type: "bytes32" }, { name: "intentB", type: "bytes32" }, { name: "terms", type: "bytes32" },
  ],
};
const TERMS = ethers.id("rules v1 | card 7 stats | card 8 stats"); // stands in for the server's battle-input hash
const feeOf = (stake) => ((stake * 750n) / 10000n) * 2n; // 7.5% from each side, rounded down per side
const SETTLE_WINDOW = 7000;

// EIP-2935's history contract, byte for byte what BSC mainnet and testnet run at HISTORY (eth_getCode, 8 Nov 2026).
// Hardhat's own node has a stub there that only reverts and never writes the history, so these tests put the real
// code in and write by hand what the chain writes at the start of every block: block n's hash at slot n % 8191.
const HISTORY = "0x0000F90827F1C53a10cb7A02335B175320002935";
const HISTORY_CODE = "0x3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500";
const useHistory = () => network.provider.send("hardhat_setCode", [HISTORY, HISTORY_CODE]);
const setSlot = (n, value) => network.provider.send("hardhat_setStorageAt", [HISTORY, ethers.toQuantity(n % 8191), value]);
/** The history as the chain keeps it, for these blocks and the newest two (settle() first checks the record of the
 *  block before its own against blockhash: a history that stopped being written is never read). */
async function remember(...blocks) {
  const head = await ethers.provider.getBlockNumber();
  for (const n of [...blocks, head - 1, head]) await setSlot(n, (await ethers.provider.getBlock(n)).hash);
}
/** A block the history doesn't have (its slot empty). */
const forget = (...blocks) => Promise.all(blocks.map((n) => setSlot(n, ethers.ZeroHash)));
const seedOfBlocks = async (lockBlock) => {
  const hashes = [];
  for (let i = 0; i < 3; i++) hashes.push((await ethers.provider.getBlock(lockBlock + i)).hash);
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32[]"], [hashes]));
};

async function deploy(overrides = {}) {
  const { maxOpenDuels = MAX_OPEN_DUELS, maxLockedValue = MAX_LOCKED_VALUE } = overrides;
  await useHistory();
  const [owner, treasury, serverKey, a, b, c, other] = await ethers.getSigners();
  const cards = await ethers.deployContract("MockCards");
  const duels = await ethers.deployContract("StakedDuels", [
    owner.address, await cards.getAddress(), treasury.address, serverKey.address, STAKE, MAX_BALANCE,
    maxOpenDuels, maxLockedValue,
  ]);
  await cards.mint(a.address, 7);
  await cards.mint(b.address, 8);
  await cards.mint(c.address, 9);
  const domain = async () => ({
    name: "StakedDuels", version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await duels.getAddress(),
  });

  let nonce = 0;
  const intent = async (over = {}, by) => {
    const v = {
      player: a.address, cardId: 7, stake: STAKE, opponent: ZERO, nonce: nonce++,
      expiry: (await time.latest()) + 600, ...over,
    };
    const sig = await (by ?? (await ethers.getSigner(v.player))).signTypedData(await domain(), INTENT_TYPES, v);
    return [v, sig];
  };

  // The server's signature over one exact pairing; `by` other than serverKey plays an attacker.
  const matchSig = async (ia, ib, terms = TERMS, by = serverKey) => {
    const v = { intentA: await duels.intentDigest(ia), intentB: await duels.intentDigest(ib), terms };
    return by.signTypedData(await domain(), MATCH_TYPES, v);
  };
  const fd = async (ia, sigA, ib, sigB, { terms = TERMS, by } = {}) =>
    duels.formDuel(ia, sigA, ib, sigB, terms, await matchSig(ia, ib, terms, by));

  const form = async (overA = {}, overB = {}, byA, byB) => {
    const [ia, sigA] = await intent({ player: a.address, cardId: 7, ...overA }, byA);
    const [ib, sigB] = await intent({ player: b.address, cardId: 8, ...overB }, byB);
    const tx = await fd(ia, sigA, ib, sigB);
    const receipt = await tx.wait();
    const ev = receipt.logs.map((l) => { try { return duels.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "DuelFormed");
    return { tx, duelId: ev.args.duelId, ia, ib };
  };

  const seedSig = async (duelId, winner, by = serverKey) => {
    const seed = await duels.seedOf(duelId);
    const v = { duelId, winner, seed };
    const sig = await by.signTypedData(await domain(), SETTLE_TYPES, v);
    return [v, sig, seed];
  };

  return { owner, treasury, serverKey, a, b, c, other, cards, duels, domain, intent, matchSig, fd, form, seedSig };
}

describe("StakedDuels", () => {
  describe("deposit and withdraw", () => {
    it("deposits add to balance, capped at maxBalance", async () => {
      const { a, duels } = await deploy();
      await expect(duels.connect(a).deposit({ value: STAKE })).to.emit(duels, "Deposited").withArgs(a.address, STAKE, STAKE);
      expect(await duels.balanceOf(a.address)).to.equal(STAKE);
      await expect(duels.connect(a).deposit({ value: MAX_BALANCE })).to.be.revertedWithCustomError(duels, "BalanceCapExceeded");
      await expect(duels.connect(a).deposit({ value: 0 })).to.be.revertedWithCustomError(duels, "ZeroAmount");
    });

    it("withdraws from free balance any time, even paused, but not past what is free", async () => {
      const { owner, a, duels } = await deploy();
      await duels.connect(a).deposit({ value: STAKE * 2n });
      await duels.connect(owner).setPaused(true);
      await expect(duels.connect(a).withdraw(STAKE)).to.changeEtherBalances([a, duels], [STAKE, -STAKE]);
      await expect(duels.connect(a).withdraw(STAKE + 1n)).to.be.revertedWithCustomError(duels, "InsufficientBalance");
      await expect(duels.connect(a).withdraw(0)).to.be.revertedWithCustomError(duels, "InsufficientBalance");
    });

    it("blocks deposit while paused", async () => {
      const { owner, a, duels } = await deploy();
      await duels.connect(owner).setPaused(true);
      await expect(duels.connect(a).deposit({ value: STAKE })).to.be.revertedWithCustomError(duels, "ContractPaused");
    });

    it("guards withdraw against reentrancy", async () => {
      const { a, duels } = await deploy();
      const hostile = await ethers.deployContract("HostileWithdrawer");
      await hostile.arm(await duels.getAddress());
      await hostile.connect(a).deposit({ value: STAKE * 2n });
      await expect(hostile.connect(a).withdraw(STAKE)).to.be.reverted; // the re-entered withdraw(1) must fail the guard
    });
  });

  describe("forming a duel", () => {
    it("locks both stakes and opens the duel; a signed Intent that is never matched touches no balance", async () => {
      const { a, b, duels, intent, form } = await deploy();
      await duels.connect(a).deposit({ value: STAKE });
      await duels.connect(b).deposit({ value: STAKE });
      const [unused] = await intent({ player: a.address, cardId: 7 });
      expect(await duels.balanceOf(a.address)).to.equal(STAKE); // signing alone changed nothing
      const { duelId } = await form();
      expect(await duels.balanceOf(a.address)).to.equal(0n);
      expect(await duels.balanceOf(b.address)).to.equal(0n);
      const d = await duels.duels(duelId);
      expect(d.status).to.equal(LOCKED);
      expect(await duels.openDuelOfCard(7)).to.equal(duelId);
      expect(await duels.openDuelOfCard(8)).to.equal(duelId);
    });

    it("refuses a duel with itself, an unheld card, a busy card, mismatched or disallowed stakes", async () => {
      const { a, b, c, duels, intent, fd, form } = await deploy();
      await duels.connect(a).deposit({ value: STAKE * 3n });
      await duels.connect(b).deposit({ value: STAKE * 3n });
      await duels.connect(c).deposit({ value: STAKE * 3n });

      const [ia, sigA] = await intent({ player: a.address, cardId: 7 });
      const [ib, sigB] = await intent({ player: a.address, cardId: 7 }); // same player both sides
      await expect(fd(ia, sigA, ib, sigB)).to.be.revertedWithCustomError(duels, "SamePlayer");

      const [notHeld, notHeldSig] = await intent({ player: a.address, cardId: 9 }); // a doesn't hold 9
      const [ibOk, sigBOk] = await intent({ player: b.address, cardId: 8 });
      await expect(fd(notHeld, notHeldSig, ibOk, sigBOk)).to.be.revertedWithCustomError(duels, "NotCardHolder");

      const { } = await form();
      const [iaAgain, sigAAgain] = await intent({ player: a.address, cardId: 7 });
      const [icFresh, sigCFresh] = await intent({ player: c.address, cardId: 9 });
      await expect(fd(iaAgain, sigAAgain, icFresh, sigCFresh)).to.be.revertedWithCustomError(duels, "CardBusy");

      const [iaStake, sigAStake] = await intent({ player: b.address, cardId: 8, stake: STAKE });
      const [icStake, sigCStake] = await intent({ player: c.address, cardId: 9, stake: STAKE * 2n });
      await expect(fd(iaStake, sigAStake, icStake, sigCStake)).to.be.revertedWithCustomError(duels, "StakeMismatch");

      const [iaBad, sigABad] = await intent({ player: b.address, cardId: 8, stake: BNB("0.0017") });
      const [icBad, sigCBad] = await intent({ player: c.address, cardId: 9, stake: BNB("0.0017") });
      await expect(fd(iaBad, sigABad, icBad, sigCBad)).to.be.revertedWithCustomError(duels, "StakeNotAllowed");
    });

    it("enforces a direct challenge's named opponent but leaves the open table to the matchmaker", async () => {
      const { a, b, c, duels, intent, fd } = await deploy();
      await duels.connect(a).deposit({ value: STAKE });
      await duels.connect(b).deposit({ value: STAKE });
      await duels.connect(c).deposit({ value: STAKE });
      const [ia, sigA] = await intent({ player: a.address, cardId: 7, opponent: c.address }); // a challenges c only
      const [ib, sigB] = await intent({ player: b.address, cardId: 8 });
      await expect(fd(ia, sigA, ib, sigB)).to.be.revertedWithCustomError(duels, "OpponentMismatch");
      const [ic, sigC] = await intent({ player: c.address, cardId: 9 });
      await expect(fd(ia, sigA, ic, sigC)).to.emit(duels, "DuelFormed");
    });

    it("refuses insufficient balance, an expired Intent, a reused Intent and a forged signature", async () => {
      const { a, b, other, duels, intent, fd } = await deploy();
      await duels.connect(b).deposit({ value: STAKE });
      const [ia, sigA] = await intent({ player: a.address, cardId: 7 }); // a never deposited
      const [ib, sigB] = await intent({ player: b.address, cardId: 8 });
      await expect(fd(ia, sigA, ib, sigB)).to.be.revertedWithCustomError(duels, "InsufficientBalance");

      await duels.connect(a).deposit({ value: STAKE });
      const [old, oldSig] = await intent({ player: a.address, cardId: 7, expiry: (await time.latest()) + 5 });
      await time.increase(10);
      await expect(fd(old, oldSig, ib, sigB)).to.be.revertedWithCustomError(duels, "ExpiredIntent");

      const [fresh, freshSig] = await intent({ player: a.address, cardId: 7 });
      await fd(fresh, freshSig, ib, sigB);
      const [ib2, sigB2] = await intent({ player: b.address, cardId: 8 });
      await duels.connect(a).deposit({ value: STAKE });
      await expect(fd(fresh, freshSig, ib2, sigB2)).to.be.revertedWithCustomError(duels, "UsedIntent");

      const [forged, forgedSig] = await intent({ player: a.address, cardId: 7 }, other);
      await expect(fd(forged, forgedSig, ib2, sigB2)).to.be.revertedWithCustomError(duels, "BadIntentSignature");
    });

    it("blocks new duels while paused", async () => {
      const { owner, a, b, duels, intent, fd } = await deploy();
      await duels.connect(a).deposit({ value: STAKE });
      await duels.connect(b).deposit({ value: STAKE });
      await duels.connect(owner).setPaused(true);
      const [ia, sigA] = await intent({ player: a.address, cardId: 7 });
      const [ib, sigB] = await intent({ player: b.address, cardId: 8 });
      await expect(fd(ia, sigA, ib, sigB)).to.be.revertedWithCustomError(duels, "ContractPaused");
    });

    // Gas the server pays for locking one duel (~339k: ~332k before the audit, +~7k for checking the server's
    // Match signature). At the live BSC gasPrice (~0.05 gwei, eth_gasPrice on bsc-rpc.publicnode.com) and BNB at
    // $695, that's ~$0.0118 — see staked-duel-tasarim.md "Kontroller". The ceiling here is a
    // regression guard, not the cost figure itself: re-measure before trusting the dollar math.
    it("locks a duel within its gas budget", async () => {
      const { a, b, duels, form } = await deploy();
      await duels.connect(a).deposit({ value: STAKE });
      await duels.connect(b).deposit({ value: STAKE });
      const { tx } = await form();
      const receipt = await tx.wait();
      console.log(`      formDuel gas: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.lte(345000n);
    });
  });

  describe("stolen-key blast radius caps", () => {
    it("caps simultaneous open duels; a settled duel frees the slot for a new one", async () => {
      const { a, b, cards, duels, intent, fd, form, seedSig } = await deploy({ maxOpenDuels: 1 });
      const signers = await ethers.getSigners();
      const [d, e] = [signers[7], signers[8]];
      await cards.mint(d.address, 10);
      await cards.mint(e.address, 11);
      await duels.connect(a).deposit({ value: STAKE });
      await duels.connect(b).deposit({ value: STAKE });
      await duels.connect(d).deposit({ value: STAKE });
      await duels.connect(e).deposit({ value: STAKE });
      const { duelId } = await form(); // a vs b fills the one open-duel slot
      expect(await duels.openDuelCount()).to.equal(1n);
      const [id1, sigD] = await intent({ player: d.address, cardId: 10 });
      const [id2, sigE] = await intent({ player: e.address, cardId: 11 });
      await expect(fd(id1, sigD, id2, sigE)).to.be.revertedWithCustomError(duels, "TooManyOpenDuels");

      await mine(5);
      const [, sig] = await seedSig(duelId, a.address);
      await duels.settle(duelId, a.address, sig);
      expect(await duels.openDuelCount()).to.equal(0n);
      await expect(fd(id1, sigD, id2, sigE)).to.emit(duels, "DuelFormed");
    });

    it("caps total value locked across open duels; a timeout refund frees the room", async () => {
      const pot = STAKE * 2n; // exactly one duel's worth
      const { a, b, cards, duels, intent, fd, form } = await deploy({ maxLockedValue: pot });
      const signers = await ethers.getSigners();
      const [d, e] = [signers[7], signers[8]];
      await cards.mint(d.address, 10);
      await cards.mint(e.address, 11);
      await duels.connect(a).deposit({ value: STAKE });
      await duels.connect(b).deposit({ value: STAKE });
      await duels.connect(d).deposit({ value: STAKE });
      await duels.connect(e).deposit({ value: STAKE });
      const { duelId } = await form(); // uses up the entire maxLockedValue
      expect(await duels.lockedValue()).to.equal(pot);
      const [id1, sigD] = await intent({ player: d.address, cardId: 10 });
      const [id2, sigE] = await intent({ player: e.address, cardId: 11 });
      await expect(fd(id1, sigD, id2, sigE)).to.be.revertedWithCustomError(duels, "LockedValueCapExceeded");

      await time.increase(TIMEOUT + 1);
      await duels.refundTimeout(duelId);
      expect(await duels.lockedValue()).to.equal(0n);
      const [id3, sigD2] = await intent({ player: d.address, cardId: 10 }); // re-signed: the earlier pair expired
      const [id4, sigE2] = await intent({ player: e.address, cardId: 11 });
      await expect(fd(id3, sigD2, id4, sigE2)).to.emit(duels, "DuelFormed");
    });
  });

  describe("settling", () => {
    async function locked() {
      const ctx = await deploy();
      await ctx.duels.connect(ctx.a).deposit({ value: STAKE });
      await ctx.duels.connect(ctx.b).deposit({ value: STAKE });
      const { duelId } = await ctx.form();
      return { ...ctx, duelId };
    }

    it("has no seed and refuses settlement until the window is fully mined", async () => {
      const { a, duels, duelId, seedSig } = await locked();
      expect(await duels.seedOf(duelId)).to.equal(ethers.ZeroHash);
      const [v, sig] = await seedSig(duelId, a.address);
      await expect(duels.settle(duelId, a.address, sig)).to.be.revertedWithCustomError(duels, "SeedUnavailable");
    });

    it("pays the winner the pot minus 7.5% from each side, credited to treasury, once the signed seed matches the chain", async () => {
      const { a, b, treasury, duels, duelId, seedSig } = await locked();
      await mine(5);
      const [, sig, seed] = await seedSig(duelId, a.address);
      expect(seed).to.not.equal(ethers.ZeroHash);
      const pot = STAKE * 2n;
      const fee = feeOf(STAKE); // 7.5% of each side == 7.5% of the pot
      const payout = pot - fee;
      expect(fee).to.equal((pot * 750n) / 10000n);
      expect(payout - STAKE).to.equal((STAKE * 85n) / 100n); // the winner nets 0.85 of a stake
      await expect(duels.settle(duelId, a.address, sig)).to.emit(duels, "Settled").withArgs(duelId, a.address, seed, payout, fee);
      expect(await duels.balanceOf(a.address)).to.equal(payout);
      expect(await duels.balanceOf(b.address)).to.equal(0n);
      expect(await duels.treasuryBalance()).to.equal(fee);
      expect(await duels.openDuelOfCard(7)).to.equal(0n);
      expect(await duels.openDuelOfCard(8)).to.equal(0n);
      await expect(duels.sweepTreasury()).to.changeEtherBalances([treasury, duels], [fee, -fee]);
    });

    it("refuses a winner who wasn't in the duel, a forged signature, and settling twice", async () => {
      const { a, c, other, duels, duelId, seedSig } = await locked();
      await mine(5);
      const [, badWinnerSig] = await seedSig(duelId, c.address);
      await expect(duels.settle(duelId, c.address, badWinnerSig)).to.be.revertedWithCustomError(duels, "BadWinner");
      const [, forgedSig] = await seedSig(duelId, a.address, other);
      await expect(duels.settle(duelId, a.address, forgedSig)).to.be.revertedWithCustomError(duels, "BadSettleSignature");
      const [, sig] = await seedSig(duelId, a.address);
      await duels.settle(duelId, a.address, sig);
      await expect(duels.settle(duelId, a.address, sig)).to.be.revertedWithCustomError(duels, "DuelNotLocked");
    });

    it("blocks settlement while paused, but not the eventual timeout refund", async () => {
      const { owner, a, duels, duelId, seedSig } = await locked();
      await mine(5);
      const [, sig] = await seedSig(duelId, a.address);
      await duels.connect(owner).setPaused(true);
      await expect(duels.settle(duelId, a.address, sig)).to.be.revertedWithCustomError(duels, "ContractPaused");
      await time.increase(TIMEOUT + 1);
      await expect(duels.refundTimeout(duelId)).to.emit(duels, "Refunded");
    });

    // Gas the server pays for settling one duel. At the same inputs as the formDuel gas test, ~95k gas is ~$0.0033
    // — combined with the lock, ~$0.0151/duel against the ~$0.157 per-duel fee at 0.0015 BNB (~9.7%, under 10%).
    it("settles a duel within its gas budget", async () => {
      const { a, duels, duelId, seedSig } = await locked();
      await mine(5);
      const [, sig] = await seedSig(duelId, a.address);
      const tx = await duels.settle(duelId, a.address, sig);
      const receipt = await tx.wait();
      console.log(`      settle gas: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.lte(125000n); // ~95k before the hourly cap; the first settle of an hour pays ~24k more to open its window
    });

    // A settle more than 256 blocks after the lock reads its seed from the history: four calls to HISTORY (the record of
    // the block before, then the seed blocks blockhash no longer has), ~15k gas more (~134k against ~119k for the first
    // settle of an hour). The server's normal settle, right after the reveal (~200 blocks), still reads blockhash.
    it("settles through the history within its gas budget", async () => {
      const { a, duels, duelId, seedSig } = await locked();
      const lockBlock = Number((await duels.duels(duelId)).lockBlock);
      await mine(300);
      await remember(lockBlock, lockBlock + 1, lockBlock + 2);
      const [, sig] = await seedSig(duelId, a.address);
      const receipt = await (await duels.settle(duelId, a.address, sig)).wait();
      console.log(`      settle gas through the history: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.lte(140000n);
    });

    it("still resolves correctly if a card is sold mid-duel: payout follows the staking wallet, not the card", async () => {
      const { a, b, other, cards, duels, duelId, seedSig } = await locked();
      await cards.connect(a).transferFrom(a.address, other.address, 7);
      await mine(5);
      const [, sig] = await seedSig(duelId, a.address);
      await expect(duels.settle(duelId, a.address, sig)).to.emit(duels, "Settled");
      expect(await duels.balanceOf(a.address)).to.be.gt(0n);
      expect(await duels.balanceOf(other.address)).to.equal(0n);
    });
  });

  describe("a draw", () => {
    async function lockedDraw() {
      const ctx = await deploy();
      await ctx.duels.connect(ctx.a).deposit({ value: STAKE });
      await ctx.duels.connect(ctx.b).deposit({ value: STAKE });
      const { duelId } = await ctx.form();
      return { ...ctx, duelId };
    }

    it("gives each side its exact stake back, takes no fee, leaves the treasury alone and frees everything the duel held", async () => {
      const { a, b, treasury, duels, duelId, seedSig } = await lockedDraw();
      await mine(5);
      const [, sig] = await seedSig(duelId, ZERO);
      expect(await duels.balanceOf(a.address)).to.equal(0n);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const tx = await duels.settle(duelId, ZERO, sig);
      await expect(tx).to.emit(duels, "Refunded").withArgs(duelId);
      await expect(tx).not.to.emit(duels, "Settled");
      expect(await duels.balanceOf(a.address)).to.equal(STAKE);
      expect(await duels.balanceOf(b.address)).to.equal(STAKE);
      expect(await duels.treasuryBalance()).to.equal(0n);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore);
      await expect(duels.sweepTreasury()).to.be.revertedWithCustomError(duels, "ZeroAmount");
      expect((await duels.duels(duelId)).status).to.equal(REFUNDED);
      expect(await duels.openDuelOfCard(7)).to.equal(0n);
      expect(await duels.openDuelOfCard(8)).to.equal(0n);
      expect(await duels.openDuelCount()).to.equal(0n);
      expect(await duels.lockedValue()).to.equal(0n);
      expect(await ethers.provider.getBalance(await duels.getAddress())).to.equal(STAKE * 2n); // and each can withdraw it
      await expect(duels.connect(a).withdraw(STAKE)).to.changeEtherBalances([a, duels], [STAKE, -STAKE]);
      await expect(duels.connect(b).withdraw(STAKE)).to.changeEtherBalances([b, duels], [STAKE, -STAKE]);
    });

    it("refuses a signature that isn't the signer's", async () => {
      const { other, duels, duelId, seedSig } = await lockedDraw();
      await mine(5);
      const [, forged] = await seedSig(duelId, ZERO, other);
      await expect(duels.settle(duelId, ZERO, forged)).to.be.revertedWithCustomError(duels, "BadSettleSignature");
      expect((await duels.duels(duelId)).status).to.equal(LOCKED);
    });

    it("a signature for a win can't be replayed as a draw, nor one for a draw as a win", async () => {
      const { a, b, duels, duelId, seedSig } = await lockedDraw();
      await mine(5);
      const [, winSig] = await seedSig(duelId, a.address);
      const [, drawSig] = await seedSig(duelId, ZERO);
      await expect(duels.settle(duelId, ZERO, winSig)).to.be.revertedWithCustomError(duels, "BadSettleSignature");
      await expect(duels.settle(duelId, a.address, drawSig)).to.be.revertedWithCustomError(duels, "BadSettleSignature");
      await expect(duels.settle(duelId, b.address, drawSig)).to.be.revertedWithCustomError(duels, "BadSettleSignature");
      expect((await duels.duels(duelId)).status).to.equal(LOCKED);
    });

    it("is bound to this duel and to the contract's own seed", async () => {
      const { a, b, serverKey, duels, domain, form, duelId, seedSig } = await lockedDraw();
      await mine(5);
      const seed = await duels.seedOf(duelId);
      const wrongSeed = await serverKey.signTypedData(await domain(), SETTLE_TYPES, { duelId, winner: ZERO, seed: ethers.id("another seed") });
      await expect(duels.settle(duelId, ZERO, wrongSeed)).to.be.revertedWithCustomError(duels, "BadSettleSignature");
      await duels.connect(a).deposit({ value: STAKE });
      await duels.connect(b).deposit({ value: STAKE });
      const [, sig] = await seedSig(duelId, ZERO); // for this duel
      await duels.settle(duelId, ZERO, sig);
      const { duelId: next } = await form();
      await mine(5);
      await expect(duels.settle(next, ZERO, sig)).to.be.revertedWithCustomError(duels, "BadSettleSignature");
      expect(await duels.seedOf(next)).to.not.equal(seed);
    });

    it("reverts before the seed exists and past the settle window, where the refund stays open", async () => {
      const { a, duels, duelId, seedSig } = await lockedDraw();
      expect(await duels.seedOf(duelId)).to.equal(ethers.ZeroHash);
      const [, early] = await seedSig(duelId, ZERO);
      await expect(duels.settle(duelId, ZERO, early)).to.be.revertedWithCustomError(duels, "SeedUnavailable");
      await mine(5);
      const [, sig] = await seedSig(duelId, ZERO);
      await mine(SETTLE_WINDOW);
      await expect(duels.settle(duelId, ZERO, sig)).to.be.revertedWithCustomError(duels, "SeedUnavailable");
      await expect(duels.refundTimeout(duelId)).to.emit(duels, "Refunded").withArgs(duelId);
      expect(await duels.balanceOf(a.address)).to.equal(STAKE);
    });

    it("can't be done twice, and refundTimeout after it reverts", async () => {
      const { a, b, duels, duelId, seedSig } = await lockedDraw();
      await mine(5);
      const [, sig] = await seedSig(duelId, ZERO);
      await duels.settle(duelId, ZERO, sig);
      await expect(duels.settle(duelId, ZERO, sig)).to.be.revertedWithCustomError(duels, "DuelNotLocked");
      await time.increase(TIMEOUT + 1);
      await expect(duels.refundTimeout(duelId)).to.be.revertedWithCustomError(duels, "DuelNotLocked");
      expect(await duels.balanceOf(a.address)).to.equal(STAKE); // no second refund
      expect(await duels.balanceOf(b.address)).to.equal(STAKE);
      expect(await duels.lockedValue()).to.equal(0n);
    });

    it("stops while paused, like any settle", async () => {
      const { owner, duels, duelId, seedSig } = await lockedDraw();
      await mine(5);
      const [, sig] = await seedSig(duelId, ZERO);
      await duels.connect(owner).setPaused(true);
      await expect(duels.settle(duelId, ZERO, sig)).to.be.revertedWithCustomError(duels, "ContractPaused");
      await duels.connect(owner).setPaused(false);
      await expect(duels.settle(duelId, ZERO, sig)).to.emit(duels, "Refunded");
    });

    it("uses none of the hourly cap, and goes through when the cap is full", async () => {
      const { owner, a, duels, duelId, seedSig, form, cards, intent, fd } = await lockedDraw();
      const signers = await ethers.getSigners();
      const [d, e] = [signers[7], signers[8]];
      await cards.mint(d.address, 10);
      await cards.mint(e.address, 11);
      for (const p of [d, e]) await duels.connect(p).deposit({ value: STAKE });
      await duels.connect(owner).setMaxSettlePerHour(STAKE * 2n);
      const [i1, sig1] = await intent({ player: d.address, cardId: 10 });
      const [i2, sig2] = await intent({ player: e.address, cardId: 11 });
      const r = await (await fd(i1, sig1, i2, sig2)).wait();
      const other = r.logs.map((l) => { try { return duels.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "DuelFormed").args.duelId;
      await mine(5);
      // a draw on an empty hour takes nothing from it
      const [, drawSig] = await seedSig(duelId, ZERO);
      await duels.settle(duelId, ZERO, drawSig);
      expect(await duels.settledInWindow()).to.equal(0n);
      expect(await duels.settleWindow()).to.equal(0n); // the window wasn't even opened
      // the win then fills the hour, and another draw still goes through
      const [, winSig] = await seedSig(other, d.address);
      await duels.settle(other, d.address, winSig);
      expect(await duels.settledInWindow()).to.equal(STAKE * 2n);
      await duels.connect(a).deposit({ value: STAKE });
      await duels.connect(signers[4]).deposit({ value: STAKE }); // b's stake came back; b funds the next duel too
      const { duelId: third } = await form();
      await mine(5);
      const [, drawSig2] = await seedSig(third, ZERO);
      await expect(duels.settle(third, ZERO, drawSig2)).to.emit(duels, "Refunded").withArgs(third);
      expect(await duels.settledInWindow()).to.equal(STAKE * 2n);
    });

    it("frees both cards for a new duel", async () => {
      const { a, b, duels, form, duelId, seedSig } = await lockedDraw();
      await mine(5);
      const [, sig] = await seedSig(duelId, ZERO);
      await duels.settle(duelId, ZERO, sig);
      const { duelId: next } = await form(); // the same two cards, paid from the stakes that came back
      expect(next).to.equal(duelId + 1n);
      expect((await duels.duels(next)).status).to.equal(LOCKED);
      expect(await duels.openDuelOfCard(7)).to.equal(next);
      expect(await duels.balanceOf(a.address)).to.equal(0n);
      expect(await duels.balanceOf(b.address)).to.equal(0n);
    });

    it("a non-zero winner must still be one of the two players", async () => {
      const { c, duels, duelId, seedSig } = await lockedDraw();
      await mine(5);
      const [, sig] = await seedSig(duelId, c.address);
      await expect(duels.settle(duelId, c.address, sig)).to.be.revertedWithCustomError(duels, "BadWinner");
    });
  });

  describe("the 24-hour refund", () => {
    it("refuses refund before the deadline and after settlement, and pays both sides back exactly once", async () => {
      const { a, b, duels, duelId, seedSig } = await (async () => {
        const ctx = await deploy();
        await ctx.duels.connect(ctx.a).deposit({ value: STAKE });
        await ctx.duels.connect(ctx.b).deposit({ value: STAKE });
        const { duelId } = await ctx.form();
        return { ...ctx, duelId };
      })();
      await expect(duels.refundTimeout(duelId)).to.be.revertedWithCustomError(duels, "TimeoutNotReached");
      await time.increase(TIMEOUT + 1);
      await expect(duels.refundTimeout(duelId)).to.emit(duels, "Refunded").withArgs(duelId);
      expect(await duels.balanceOf(a.address)).to.equal(STAKE);
      expect(await duels.balanceOf(b.address)).to.equal(STAKE);
      expect(await duels.openDuelOfCard(7)).to.equal(0n);
      await expect(duels.refundTimeout(duelId)).to.be.revertedWithCustomError(duels, "DuelNotLocked");
    });

    it("a missed settle window can never be settled, even with the history still holding the seed blocks, and refunds at once", async () => {
      const { a, duels, duelId, seedSig } = await (async () => {
        const ctx = await deploy();
        await ctx.duels.connect(ctx.a).deposit({ value: STAKE });
        await ctx.duels.connect(ctx.b).deposit({ value: STAKE });
        const { duelId } = await ctx.form();
        return { ...ctx, duelId };
      })();
      const lockBlock = Number((await duels.duels(duelId)).lockBlock);
      await mine(5);
      const [, sig] = await seedSig(duelId, a.address); // signed in time, sent too late
      await mine(SETTLE_WINDOW); // the history serves 8,191 blocks: these are still in it
      await remember(lockBlock, lockBlock + 1, lockBlock + 2);
      expect(await duels.seedOf(duelId)).to.equal(ethers.ZeroHash);
      await expect(duels.settle(duelId, a.address, sig)).to.be.revertedWithCustomError(duels, "SeedUnavailable");
      await expect(duels.refundTimeout(duelId)).to.emit(duels, "Refunded"); // no 24-hour wait
    });

    it("a seed block the chain can't serve can't be settled: the refund waits for the window's end, or 24 hours", async () => {
      const ctx = await deploy();
      for (const p of [ctx.a, ctx.b]) await ctx.duels.connect(p).deposit({ value: STAKE });
      const one = await ctx.form();
      const lockBlock = Number((await ctx.duels.duels(one.duelId)).lockBlock);
      await mine(300);
      await remember();
      await forget(lockBlock); // the history has the newest blocks but not this one
      expect(await ctx.duels.seedOf(one.duelId)).to.equal(ethers.ZeroHash);
      const v = { duelId: one.duelId, winner: ctx.a.address, seed: await seedOfBlocks(lockBlock) };
      const sig = await ctx.serverKey.signTypedData(await ctx.domain(), SETTLE_TYPES, v); // the right seed, signed
      await expect(ctx.duels.settle(one.duelId, ctx.a.address, sig)).to.be.revertedWithCustomError(ctx.duels, "SeedUnavailable");
      await expect(ctx.duels.refundTimeout(one.duelId)).to.be.revertedWithCustomError(ctx.duels, "TimeoutNotReached");
      await time.increase(TIMEOUT + 1);
      await expect(ctx.duels.refundTimeout(one.duelId)).to.emit(ctx.duels, "Refunded");
    });
  });

  describe("the block-hash history (EIP-2935)", () => {
    async function lockedDuel() {
      const ctx = await deploy();
      await ctx.duels.connect(ctx.a).deposit({ value: STAKE });
      await ctx.duels.connect(ctx.b).deposit({ value: STAKE });
      const { duelId } = await ctx.form();
      return { ...ctx, duelId, lockBlock: Number((await ctx.duels.duels(duelId)).lockBlock) };
    }

    it("past 256 blocks the seed comes from the history, the same seed blockhash gave, and the duel settles to the wei", async () => {
      const { a, b, treasury, duels, duelId, lockBlock, seedSig } = await lockedDuel();
      await mine(5);
      const early = await duels.seedOf(duelId); // read through blockhash
      expect(early).to.equal(await seedOfBlocks(lockBlock));
      await mine(300); // blockhash no longer has lockBlock
      expect(await duels.seedOf(duelId)).to.equal(ethers.ZeroHash); // nothing written to the history yet
      await remember(lockBlock, lockBlock + 1, lockBlock + 2);
      expect(await duels.seedOf(duelId)).to.equal(early);
      const [, sig, seed] = await seedSig(duelId, b.address);
      expect(seed).to.equal(early);
      const fee = feeOf(STAKE);
      await expect(duels.settle(duelId, b.address, sig)).to.emit(duels, "Settled").withArgs(duelId, b.address, early, STAKE * 2n - fee, fee);
      expect(await duels.balanceOf(b.address)).to.equal(STAKE * 2n - fee);
      expect(await duels.balanceOf(a.address)).to.equal(0n);
      await expect(duels.sweepTreasury()).to.changeEtherBalances([treasury, duels], [fee, -fee]);
    });

    it("never reads a history whose record of the previous block is wrong: one that stopped being written hands back old hashes", async () => {
      const { a, duels, duelId, lockBlock, seedSig } = await lockedDuel();
      await mine(300);
      await remember(lockBlock, lockBlock + 1, lockBlock + 2);
      expect(await duels.seedOf(duelId)).to.not.equal(ethers.ZeroHash);
      const [, sig] = await seedSig(duelId, a.address);
      // the newest blocks' slots still hold hashes from 8,191 blocks before them, as if the chain stopped writing
      const head = await ethers.provider.getBlockNumber();
      for (const n of [head - 1, head]) await setSlot(n, ethers.id(`a block 8191 earlier than ${n}`));
      expect(await duels.seedOf(duelId)).to.equal(ethers.ZeroHash);
      await expect(duels.settle(duelId, a.address, sig)).to.be.revertedWithCustomError(duels, "SeedUnavailable");
      await remember(); // written again
      await expect(duels.settle(duelId, a.address, sig)).to.emit(duels, "Settled");
    });

    it("settles up to lockBlock + SETTLE_WINDOW; from the next block on, never again, and the refund is open at once", async () => {
      // (on the hardhat network a reverting call is still mined, one block each, so every step is placed by hand)
      // duel 1: its settle lands on lockBlock + SETTLE_WINDOW, the last block it can
      const { a, b, duels, form, seedSig, duelId: one, lockBlock: lock1 } = await lockedDuel();
      await mine(5);
      const [, sig1] = await seedSig(one, a.address);
      await mine(lock1 + SETTLE_WINDOW - 1 - (await ethers.provider.getBlockNumber()));
      await remember(lock1, lock1 + 1, lock1 + 2);
      const tx = await duels.settle(one, a.address, sig1);
      expect((await tx.wait()).blockNumber).to.equal(lock1 + SETTLE_WINDOW);

      // duel 2: on lockBlock + SETTLE_WINDOW it can still be settled, so no refund yet; one block later the seed is
      // gone for good (the history still has it), and the stakes come back without waiting a day
      await duels.connect(b).deposit({ value: STAKE });
      const { duelId: two } = await form();
      const lock2 = Number((await duels.duels(two)).lockBlock);
      await mine(5);
      const [, sig2] = await seedSig(two, a.address);
      await mine(lock2 + SETTLE_WINDOW - 1 - (await ethers.provider.getBlockNumber()));
      await remember(lock2, lock2 + 1, lock2 + 2);
      await expect(duels.refundTimeout(two)).to.be.revertedWithCustomError(duels, "TimeoutNotReached"); // mined on +7000
      expect(await ethers.provider.getBlockNumber()).to.equal(lock2 + SETTLE_WINDOW);
      await remember();
      await expect(duels.settle(two, a.address, sig2)).to.be.revertedWithCustomError(duels, "SeedUnavailable"); // +7001
      const balA = await duels.balanceOf(a.address);
      const balB = await duels.balanceOf(b.address);
      await expect(duels.refundTimeout(two)).to.emit(duels, "Refunded").withArgs(two);
      expect(await duels.balanceOf(a.address)).to.equal(balA + STAKE);
      expect(await duels.balanceOf(b.address)).to.equal(balB + STAKE);
      expect(await duels.lockedValue()).to.equal(0n);
      expect(await duels.openDuelCount()).to.equal(0n);
    });

    it("inside 256 blocks a duel settles with no history at all; a chain without one can't deploy the contract", async () => {
      const { owner, treasury, serverKey, a, cards, duels, duelId, seedSig } = await lockedDuel();
      await network.provider.send("hardhat_setCode", [HISTORY, "0x"]);
      try {
        await mine(5);
        const [, sig] = await seedSig(duelId, a.address);
        await expect(duels.settle(duelId, a.address, sig)).to.emit(duels, "Settled");
        await expect(ethers.deployContract("StakedDuels", [
          owner.address, await cards.getAddress(), treasury.address, serverKey.address, STAKE, MAX_BALANCE, MAX_OPEN_DUELS, MAX_LOCKED_VALUE,
        ])).to.be.revertedWithCustomError(duels, "NoBlockHashHistory");
      } finally {
        await useHistory();
      }
    });
  });

  describe("audit fixes", () => {
    async function funded() {
      const ctx = await deploy();
      for (const p of [ctx.a, ctx.b, ctx.c]) await ctx.duels.connect(p).deposit({ value: STAKE * 4n });
      return ctx;
    }

    it("an open-table Intent can only be paired the way the server signed it (no sniping, no free cap-filling)", async () => {
      const { a, b, c, duels, intent, fd, matchSig } = await funded();
      const [ia, sigA] = await intent({ player: a.address, cardId: 7 }); // a joins the open table
      const [ic, sigC] = await intent({ player: c.address, cardId: 9 }); // c copies it and brings its own card
      await expect(fd(ia, sigA, ic, sigC, { by: c })).to.be.revertedWithCustomError(duels, "BadMatchSignature");
      await expect(fd(ia, sigA, ic, sigC, { by: a })).to.be.revertedWithCustomError(duels, "BadMatchSignature");

      // the server paired a with b; a different terms hash, a swapped order or a different partner all fail
      const [ib, sigB] = await intent({ player: b.address, cardId: 8 });
      const sig = await matchSig(ia, ib);
      await expect(duels.formDuel(ia, sigA, ib, sigB, ethers.id("friendlier stats"), sig)).to.be.revertedWithCustomError(duels, "BadMatchSignature");
      await expect(duels.formDuel(ib, sigB, ia, sigA, TERMS, sig)).to.be.revertedWithCustomError(duels, "BadMatchSignature");
      await expect(duels.formDuel(ia, sigA, ic, sigC, TERMS, sig)).to.be.revertedWithCustomError(duels, "BadMatchSignature");

      // anyone may relay the exact signed pairing (copying a pending one forms the same duel), once
      await expect(duels.connect(c).formDuel(ia, sigA, ib, sigB, TERMS, sig)).to.emit(duels, "DuelFormed");
      await expect(duels.connect(c).formDuel(ia, sigA, ib, sigB, TERMS, sig)).to.be.revertedWithCustomError(duels, "UsedIntent");
    });

    it("emits the committed battle inputs (terms) when the duel locks, before the seed exists", async () => {
      const { a, b, duels, intent, fd } = await funded();
      const [ia, sigA] = await intent({ player: a.address, cardId: 7 });
      const [ib, sigB] = await intent({ player: b.address, cardId: 8 });
      const tx = await fd(ia, sigA, ib, sigB);
      const block = (await tx.wait()).blockNumber;
      await expect(tx).to.emit(duels, "DuelFormed")
        .withArgs(1n, a.address, b.address, 7n, 8n, STAKE, BigInt(block + 1), (v) => v > 0n, TERMS);
    });

    it("a player can cancel their own signed Intent, even while paused; nobody else can", async () => {
      const { owner, a, b, duels, intent, fd } = await funded();
      const [ia, sigA] = await intent({ player: a.address, cardId: 7 });
      const [ib, sigB] = await intent({ player: b.address, cardId: 8 });
      await expect(duels.connect(b).cancelIntent(ia)).to.be.revertedWithCustomError(duels, "NotIntentPlayer");
      await duels.connect(owner).setPaused(true);
      await expect(duels.connect(a).cancelIntent(ia)).to.emit(duels, "IntentCancelled").withArgs(a.address, await duels.intentDigest(ia));
      await duels.connect(owner).setPaused(false);
      await expect(fd(ia, sigA, ib, sigB)).to.be.revertedWithCustomError(duels, "UsedIntent");
    });

    it("refuses a card that changed hands between signing and locking", async () => {
      const { a, b, other, cards, duels, intent, fd } = await funded();
      const [ia, sigA] = await intent({ player: a.address, cardId: 7 });
      const [ib, sigB] = await intent({ player: b.address, cardId: 8 });
      await cards.connect(a).transferFrom(a.address, other.address, 7);
      await expect(fd(ia, sigA, ib, sigB)).to.be.revertedWithCustomError(duels, "NotCardHolder");
    });

    it("rejects an Intent replayed on another copy of the contract, on another chain, or with a high-s twin signature", async () => {
      const { owner, treasury, serverKey, a, b, cards, duels, domain, intent, fd } = await funded();
      const [ia, sigA] = await intent({ player: a.address, cardId: 7 });
      const [ib, sigB] = await intent({ player: b.address, cardId: 8 });

      const copy = await ethers.deployContract("StakedDuels", [
        owner.address, await cards.getAddress(), treasury.address, serverKey.address, STAKE, MAX_BALANCE, 10, BNB("1"),
      ]);
      await copy.connect(a).deposit({ value: STAKE });
      await copy.connect(b).deposit({ value: STAKE });
      const copyDomain = { ...(await domain()), verifyingContract: await copy.getAddress() };
      const copyMatch = await serverKey.signTypedData(copyDomain, MATCH_TYPES,
        { intentA: await copy.intentDigest(ia), intentB: await copy.intentDigest(ib), terms: TERMS });
      await expect(copy.formDuel(ia, sigA, ib, sigB, TERMS, copyMatch)).to.be.revertedWithCustomError(copy, "BadIntentSignature");

      const otherChain = { ...(await domain()), chainId: 97n };
      const sigOtherChain = await a.signTypedData(otherChain, INTENT_TYPES, ia);
      await expect(fd(ia, sigOtherChain, ib, sigB)).to.be.revertedWithCustomError(duels, "BadIntentSignature");

      const n = ethers.toBigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
      const parsed = ethers.Signature.from(sigA);
      const highS = ethers.concat([parsed.r, ethers.toBeHex(n - ethers.toBigInt(parsed.s), 32), parsed.v === 27 ? "0x1c" : "0x1b"]);
      await expect(fd(ia, highS, ib, sigB)).to.be.revertedWithCustomError(duels, "ECDSAInvalidSignatureS");
    });

    it("the seed is the contract's own read of the three block hashes after the lock block", async () => {
      const { a, duels, form } = await funded();
      const { duelId } = await form();
      await mine(4); // eth_call runs at the latest block: lockBlock + 3 is the first one that can read all three
      const lockBlock = Number((await duels.duels(duelId)).lockBlock);
      const hashes = [];
      for (let i = 0; i < 3; i++) hashes.push((await ethers.provider.getBlock(lockBlock + i)).hash);
      const expected = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32[]"], [hashes]));
      expect(await duels.seedOf(duelId)).to.equal(expected);
    });

    it("rounds the cut down per side for an odd stake, and every wei stays accounted for", async () => {
      const { owner, a, b, c, treasury, duels, form, seedSig } = await funded();
      const odd = 1_000_000_000_000_003n; // 7.5% of it is not a whole number of wei
      await duels.connect(owner).setStakeAllowed(odd, true);
      const { duelId } = await form({ stake: odd }, { stake: odd });
      await mine(5);
      const [, sig] = await seedSig(duelId, b.address);
      const fee = feeOf(odd);
      expect(fee).to.equal(150_000_000_000_000n); // 2 x floor(75_000_000_000_000.225)
      const before = await duels.balanceOf(b.address);
      await expect(duels.settle(duelId, b.address, sig)).to.emit(duels, "Settled").withArgs(duelId, b.address, (s) => true, odd * 2n - fee, fee);
      expect(await duels.balanceOf(b.address)).to.equal(before + odd * 2n - fee);

      const held = await ethers.provider.getBalance(await duels.getAddress());
      let owed = (await duels.lockedValue()) + (await duels.treasuryBalance());
      for (const p of [a, b, c]) owed += await duels.balanceOf(p.address);
      expect(held).to.equal(owed);
      await expect(duels.sweepTreasury()).to.changeEtherBalances([treasury, duels], [fee, -fee]);
    });
  });

  describe("hourly settle cap", () => {
    // Two locked duels (a vs b, d vs e), cap set to exactly one pot an hour.
    async function twoLocked() {
      const ctx = await deploy();
      const signers = await ethers.getSigners();
      const [d, e] = [signers[7], signers[8]];
      await ctx.cards.mint(d.address, 10);
      await ctx.cards.mint(e.address, 11);
      for (const p of [ctx.a, ctx.b, d, e]) await ctx.duels.connect(p).deposit({ value: STAKE });
      await ctx.duels.connect(ctx.owner).setMaxSettlePerHour(STAKE * 2n);
      const first = await ctx.form();
      const [id1, sigD] = await ctx.intent({ player: d.address, cardId: 10 });
      const [id2, sigE] = await ctx.intent({ player: e.address, cardId: 11 });
      const tx = await ctx.fd(id1, sigD, id2, sigE);
      const receipt = await tx.wait();
      const ev = receipt.logs.map((l) => { try { return ctx.duels.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "DuelFormed");
      await mine(5);
      return { ...ctx, d, e, duel1: first.duelId, duel2: ev.args.duelId };
    }

    it("defaults to 0.15 BNB an hour", async () => {
      const { duels } = await deploy();
      expect(await duels.maxSettlePerHour()).to.equal(BNB("0.15"));
    });

    it("stops a settle that would pass the cap, and a new hour opens it again", async () => {
      const { a, d, duels, duel1, duel2, seedSig } = await twoLocked();
      const [, sig1] = await seedSig(duel1, a.address);
      await duels.settle(duel1, a.address, sig1); // uses the whole hour
      expect(await duels.settledInWindow()).to.equal(STAKE * 2n);
      const [, sig2] = await seedSig(duel2, d.address);
      await expect(duels.settle(duel2, d.address, sig2)).to.be.revertedWithCustomError(duels, "HourlySettleCapExceeded");
      expect((await duels.duels(duel2)).status).to.equal(LOCKED); // untouched, still waiting
      await time.increase(3601);
      await expect(duels.settle(duel2, d.address, sig2)).to.emit(duels, "Settled");
      expect(await duels.settledInWindow()).to.equal(STAKE * 2n); // the counter restarted in the new window
    });

    it("lets the owner change it at once, with an event; nobody else, and never zero", async () => {
      const { owner, a, d, other, duels, duel1, duel2, seedSig } = await twoLocked();
      const [, sig1] = await seedSig(duel1, a.address);
      await duels.settle(duel1, a.address, sig1);
      const [, sig2] = await seedSig(duel2, d.address);
      await expect(duels.settle(duel2, d.address, sig2)).to.be.revertedWithCustomError(duels, "HourlySettleCapExceeded");
      await expect(duels.connect(other).setMaxSettlePerHour(STAKE * 4n)).to.be.revertedWithCustomError(duels, "OwnableUnauthorizedAccount");
      await expect(duels.connect(owner).setMaxSettlePerHour(0)).to.be.revertedWithCustomError(duels, "ZeroAmount");
      await expect(duels.connect(owner).setMaxSettlePerHour(STAKE * 4n)).to.emit(duels, "MaxSettlePerHourSet").withArgs(STAKE * 4n);
      expect(await duels.maxSettlePerHour()).to.equal(STAKE * 4n);
      await expect(duels.settle(duel2, d.address, sig2)).to.emit(duels, "Settled"); // same hour, now under the new cap
    });

    it("never blocks refunds, withdraw or cancelIntent, even with the cap used up", async () => {
      const { a, d, e, duels, intent, duel1, duel2, seedSig } = await twoLocked();
      const [, sig1] = await seedSig(duel1, a.address);
      await duels.settle(duel1, a.address, sig1); // cap used up this hour
      const [, sig2] = await seedSig(duel2, d.address);
      await expect(duels.settle(duel2, d.address, sig2)).to.be.revertedWithCustomError(duels, "HourlySettleCapExceeded");
      await expect(duels.connect(a).withdraw(STAKE)).to.changeEtherBalances([a], [STAKE]);
      const [iv] = await intent({ player: a.address, cardId: 7 });
      await expect(duels.connect(a).cancelIntent(iv)).to.emit(duels, "IntentCancelled");
      await time.increase(TIMEOUT - 3000); // still the same cap state is irrelevant to refunds; wait out the deadline
      await time.increase(3100);
      await expect(duels.refundTimeout(duel2)).to.emit(duels, "Refunded").withArgs(duel2);
      expect(await duels.balanceOf(d.address)).to.equal(STAKE);
      expect(await duels.balanceOf(e.address)).to.equal(STAKE);
      await expect(duels.connect(d).withdraw(STAKE)).to.changeEtherBalances([d], [STAKE]);
    });
  });

  describe("treasury sweep", () => {
    it("is permissionless, pays the fixed treasury, and refuses to sweep nothing", async () => {
      const { other, treasury, duels } = await deploy();
      await expect(duels.connect(other).sweepTreasury()).to.be.revertedWithCustomError(duels, "ZeroAmount");
    });
  });

  describe("owner settings", () => {
    it("pause, stake tiers and the balance cap move at once and only for the owner", async () => {
      const { owner, other, duels } = await deploy();
      await expect(duels.connect(other).setPaused(true)).to.be.revertedWithCustomError(duels, "OwnableUnauthorizedAccount");
      await expect(duels.connect(other).setStakeAllowed(STAKE, false)).to.be.revertedWithCustomError(duels, "OwnableUnauthorizedAccount");
      await expect(duels.connect(other).setMaxBalance(STAKE)).to.be.revertedWithCustomError(duels, "OwnableUnauthorizedAccount");

      await expect(duels.connect(owner).setStakeAllowed(0, true)).to.be.revertedWithCustomError(duels, "ZeroAmount");
      await duels.connect(owner).setStakeAllowed(BNB("0.003"), true);
      expect(await duels.stakeAllowed(BNB("0.003"))).to.equal(true);
      await duels.connect(owner).setStakeAllowed(STAKE, false);
      expect(await duels.stakeAllowed(STAKE)).to.equal(false);

      await expect(duels.connect(owner).setMaxBalance(0)).to.be.revertedWithCustomError(duels, "ZeroAmount");
      await duels.connect(owner).setMaxBalance(BNB("0.05"));
      expect(await duels.maxBalance()).to.equal(BNB("0.05"));
    });

    it("the open-duel and locked-value caps move at once and only for the owner", async () => {
      const { owner, other, duels } = await deploy();
      await expect(duels.connect(other).setMaxOpenDuels(5)).to.be.revertedWithCustomError(duels, "OwnableUnauthorizedAccount");
      await expect(duels.connect(other).setMaxLockedValue(STAKE)).to.be.revertedWithCustomError(duels, "OwnableUnauthorizedAccount");

      await expect(duels.connect(owner).setMaxOpenDuels(0)).to.be.revertedWithCustomError(duels, "ZeroAmount");
      await duels.connect(owner).setMaxOpenDuels(5);
      expect(await duels.maxOpenDuels()).to.equal(5n);

      await expect(duels.connect(owner).setMaxLockedValue(0)).to.be.revertedWithCustomError(duels, "ZeroAmount");
      await duels.connect(owner).setMaxLockedValue(BNB("0.5"));
      expect(await duels.maxLockedValue()).to.equal(BNB("0.5"));
    });

    it("waits 48 hours for a new treasury or signer; only the owner may start or cancel", async () => {
      const { owner, other, duels } = await deploy();
      await expect(duels.connect(other).propose(TREASURY, BigInt(other.address))).to.be.revertedWithCustomError(duels, "OwnableUnauthorizedAccount");
      await expect(duels.connect(owner).propose(SIGNER, 0)).to.be.revertedWithCustomError(duels, "BadAddress");

      await duels.connect(owner).propose(TREASURY, BigInt(other.address));
      await duels.connect(owner).propose(SIGNER, BigInt(other.address));
      await expect(duels.connect(owner).execute(TREASURY)).to.be.revertedWithCustomError(duels, "NotReady");
      await time.increase(TIMELOCK - 5);
      await expect(duels.connect(owner).execute(TREASURY)).to.be.revertedWithCustomError(duels, "NotReady");
      await duels.connect(owner).cancel(SIGNER);
      await time.increase(5);
      await duels.connect(owner).execute(TREASURY);
      await expect(duels.connect(owner).execute(SIGNER)).to.be.revertedWithCustomError(duels, "NotReady");
      expect(await duels.treasury()).to.equal(other.address);
      expect(await duels.signer()).to.not.equal(other.address);
    });

    it("ownership waits 48 hours, can't be renounced, and a new owner inherits no proposal", async () => {
      const { owner, other, duels } = await deploy();
      await expect(duels.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(duels, "NoRenounce");
      await duels.connect(owner).propose(TREASURY, BigInt(other.address));
      await duels.connect(owner).transferOwnership(other.address);
      await expect(duels.connect(other).acceptOwnership()).to.be.revertedWithCustomError(duels, "NotReady");
      await time.increase(TIMELOCK);
      await duels.connect(other).acceptOwnership();
      expect(await duels.owner()).to.equal(other.address);
      await expect(duels.connect(other).execute(TREASURY)).to.be.revertedWithCustomError(duels, "NotReady");
    });
  });
});
