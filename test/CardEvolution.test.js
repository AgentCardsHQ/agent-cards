// CardEvolution: a server-signed voucher moves a card one stage up, its holder pays, and the money goes straight to the
// treasury. The price lives in the voucher (the discount is the server's business), bounded by the owner's limit.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const BNB = (s) => ethers.parseEther(s);
const TIMELOCK = 48 * 3600;
const FULL = BNB("0.0072");
const CHEAP = BNB("0.0045");
const [LIGHT, DARK] = [1, 2];
const [TREASURY, SIGNER, MAX_PRICE] = [0, 1, 2];
const TYPES = {
  Voucher: [
    { name: "holder", type: "address" }, { name: "id", type: "uint256" }, { name: "stage", type: "uint8" },
    { name: "side", type: "uint8" }, { name: "price", type: "uint256" }, { name: "expiry", type: "uint64" },
  ],
};

async function deploy() {
  const [owner, treasury, serverKey, a, b, other] = await ethers.getSigners();
  const cards = await ethers.deployContract("MockCards");
  const evo = await ethers.deployContract("CardEvolution", [owner.address, await cards.getAddress(), treasury.address, serverKey.address, FULL]);
  await cards.mint(a.address, 7);
  await cards.mint(b.address, 8);
  const voucher = async (over = {}, by = serverKey) => {
    const v = { holder: a.address, id: 7, stage: 1, side: LIGHT, price: FULL, expiry: (await time.latest()) + 600, ...over };
    const domain = { name: "CardEvolution", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await evo.getAddress() };
    return [v, await by.signTypedData(domain, TYPES, v)];
  };
  return { owner, treasury, serverKey, a, b, other, cards, evo, voucher };
}

async function openStageTwo(evo, owner) {
  await evo.connect(owner).proposeMaxPrice(2, FULL);
  await time.increase(TIMELOCK);
  await evo.connect(owner).execute(MAX_PRICE, 2);
}

describe("CardEvolution", () => {
  it("evolves a card at the voucher's price and pays the treasury at once, keeping nothing", async () => {
    const { a, treasury, evo, voucher } = await deploy();
    const [v, sig] = await voucher({ price: CHEAP });
    const tx = evo.connect(a).evolve(v, sig, { value: CHEAP });
    await expect(tx).to.emit(evo, "Evolved").withArgs(7, 1, LIGHT, a.address, CHEAP);
    await expect(tx).to.changeEtherBalances([a, treasury, evo], [-CHEAP, CHEAP, 0n]);
    expect(await evo.stageOf(7)).to.equal(1);
    expect(await evo.sideOf(7)).to.equal(LIGHT);
  });

  it("takes only the holder's own voucher, from the holder", async () => {
    const { a, b, other, evo, voucher } = await deploy();
    const [v, sig] = await voucher();
    await expect(evo.connect(other).evolve(v, sig, { value: FULL })).to.be.revertedWithCustomError(evo, "NotHolder");
    const [theirs, theirSig] = await voucher({ holder: b.address });
    await expect(evo.connect(b).evolve(theirs, theirSig, { value: FULL })).to.be.revertedWithCustomError(evo, "NotHolder"); // b doesn't hold 7
    await expect(evo.connect(a).evolve(v, sig, { value: FULL })).to.emit(evo, "Evolved");
  });

  it("a voucher dies with a sale, and the stage and side stay with the card", async () => {
    const { a, b, owner, cards, evo, voucher } = await deploy();
    const [v, sig] = await voucher();
    await evo.connect(a).evolve(v, sig, { value: FULL });
    await openStageTwo(evo, owner);
    const [unused, unusedSig] = await voucher({ stage: 2 });
    await cards.connect(a).transferFrom(a.address, b.address, 7);
    expect(await evo.stageOf(7)).to.equal(1);
    expect(await evo.sideOf(7)).to.equal(LIGHT);
    await expect(evo.connect(a).evolve(unused, unusedSig, { value: FULL })).to.be.revertedWithCustomError(evo, "NotHolder");
    const [next, nextSig] = await voucher({ holder: b.address, stage: 2 });
    await expect(evo.connect(b).evolve(next, nextSig, { value: FULL })).to.emit(evo, "Evolved").withArgs(7, 2, LIGHT, b.address, FULL);
  });

  it("refuses a voucher used twice, a skipped stage, a closed stage and stage 0", async () => {
    const { a, owner, evo, voucher } = await deploy();
    const [v, sig] = await voucher();
    const [skip, skipSig] = await voucher({ stage: 2 });
    await expect(evo.connect(a).evolve(skip, skipSig, { value: FULL })).to.be.revertedWithCustomError(evo, "WrongStage");
    await evo.connect(a).evolve(v, sig, { value: FULL });
    await expect(evo.connect(a).evolve(v, sig, { value: FULL })).to.be.revertedWithCustomError(evo, "WrongStage");
    await expect(evo.connect(a).evolve(skip, skipSig, { value: FULL })).to.be.revertedWithCustomError(evo, "StageClosed"); // off until opened
    await expect(evo.connect(owner).proposeMaxPrice(0, FULL)).to.be.revertedWithCustomError(evo, "WrongStage");
  });

  it("has no fixed top stage: a card goes on as far as the owner opens stages", async () => {
    const { a, owner, evo, voucher } = await deploy();
    for (let stage = 2; stage <= 9; stage++) await evo.connect(owner).proposeMaxPrice(stage, FULL);
    await time.increase(TIMELOCK);
    for (let stage = 2; stage <= 9; stage++) await evo.connect(owner).execute(MAX_PRICE, stage);
    for (let stage = 1; stage <= 9; stage++) {
      const [v, sig] = await voucher({ stage });
      await evo.connect(a).evolve(v, sig, { value: FULL });
    }
    expect(await evo.stageOf(7)).to.equal(9);
    const [next, nextSig] = await voucher({ stage: 10 });
    await expect(evo.connect(a).evolve(next, nextSig, { value: FULL })).to.be.revertedWithCustomError(evo, "StageClosed");
  });

  it("keeps the side: it must be Light or Dark, and a later stage can't change it", async () => {
    const { a, owner, evo, voucher } = await deploy();
    const [none, noneSig] = await voucher({ side: 0 });
    await expect(evo.connect(a).evolve(none, noneSig, { value: FULL })).to.be.revertedWithCustomError(evo, "BadSide");
    const [odd, oddSig] = await voucher({ side: 3 });
    await expect(evo.connect(a).evolve(odd, oddSig, { value: FULL })).to.be.revertedWithCustomError(evo, "BadSide");
    const [v, sig] = await voucher({ side: DARK });
    await evo.connect(a).evolve(v, sig, { value: FULL });
    await openStageTwo(evo, owner);
    const [swap, swapSig] = await voucher({ stage: 2, side: LIGHT });
    await expect(evo.connect(a).evolve(swap, swapSig, { value: FULL })).to.be.revertedWithCustomError(evo, "BadSide");
    const [same, sameSig] = await voucher({ stage: 2, side: DARK });
    await expect(evo.connect(a).evolve(same, sameSig, { value: FULL })).to.emit(evo, "Evolved");
    expect(await evo.sideOf(7)).to.equal(DARK);
  });

  it("bounds the price by the limit and takes exactly the voucher's price", async () => {
    const { a, evo, voucher } = await deploy();
    const [high, highSig] = await voucher({ price: FULL + 1n });
    await expect(evo.connect(a).evolve(high, highSig, { value: FULL + 1n })).to.be.revertedWithCustomError(evo, "PriceTooHigh");
    const [v, sig] = await voucher({ price: CHEAP });
    await expect(evo.connect(a).evolve(v, sig, { value: CHEAP - 1n })).to.be.revertedWithCustomError(evo, "WrongPayment");
    await expect(evo.connect(a).evolve(v, sig, { value: CHEAP + 1n })).to.be.revertedWithCustomError(evo, "WrongPayment");
  });

  it("refuses another key's signature, a changed voucher and an old voucher", async () => {
    const { a, other, evo, voucher } = await deploy();
    const [forged, forgedSig] = await voucher({}, other);
    await expect(evo.connect(a).evolve(forged, forgedSig, { value: FULL })).to.be.revertedWithCustomError(evo, "BadSignature");
    const [v, sig] = await voucher();
    const plain = { holder: v.holder, id: v.id, stage: v.stage, side: v.side, price: CHEAP, expiry: v.expiry };
    await expect(evo.connect(a).evolve(plain, sig, { value: CHEAP })).to.be.revertedWithCustomError(evo, "BadSignature");
    await time.increase(601);
    await expect(evo.connect(a).evolve(v, sig, { value: FULL })).to.be.revertedWithCustomError(evo, "Expired");
  });

  it("makes the treasury, the signer and the limits wait 48 hours; only the owner can start or cancel", async () => {
    const { owner, other, a, treasury, evo, voucher } = await deploy();
    await expect(evo.connect(other).proposeMaxPrice(1, CHEAP)).to.be.revertedWithCustomError(evo, "OwnableUnauthorizedAccount");
    await expect(evo.connect(other).propose(TREASURY, BigInt(other.address))).to.be.revertedWithCustomError(evo, "OwnableUnauthorizedAccount");
    await expect(evo.connect(other).setPaused(true)).to.be.revertedWithCustomError(evo, "OwnableUnauthorizedAccount");
    await expect(evo.connect(owner).propose(MAX_PRICE, 1)).to.be.revertedWithCustomError(evo, "BadSetting");
    await expect(evo.connect(owner).propose(SIGNER, 0)).to.be.revertedWithCustomError(evo, "BadAddress");

    await evo.connect(owner).proposeMaxPrice(1, CHEAP);
    await evo.connect(owner).propose(TREASURY, BigInt(other.address));
    await evo.connect(owner).propose(SIGNER, BigInt(other.address));
    await expect(evo.connect(owner).execute(MAX_PRICE, 1)).to.be.revertedWithCustomError(evo, "NotReady");
    await time.increase(TIMELOCK - 5);
    await expect(evo.connect(owner).execute(TREASURY, 0)).to.be.revertedWithCustomError(evo, "NotReady");
    await evo.connect(owner).cancel(SIGNER, 0);
    await time.increase(5);
    await evo.connect(owner).execute(MAX_PRICE, 1);
    await evo.connect(owner).execute(TREASURY, 0);
    await expect(evo.connect(owner).execute(SIGNER, 0)).to.be.revertedWithCustomError(evo, "NotReady");
    expect(await evo.maxPrice(1)).to.equal(CHEAP);
    expect(await evo.treasury()).to.equal(other.address);

    const [v, sig] = await voucher({ price: CHEAP });
    await expect(evo.connect(a).evolve(v, sig, { value: CHEAP })).to.changeEtherBalances([other, treasury], [CHEAP, 0n]);
  });

  it("the owner pauses and reopens at once", async () => {
    const { owner, a, evo, voucher } = await deploy();
    const [v, sig] = await voucher();
    await evo.connect(owner).setPaused(true);
    await expect(evo.connect(a).evolve(v, sig, { value: FULL })).to.be.revertedWithCustomError(evo, "VoucherPaused");
    await evo.connect(owner).setPaused(false);
    await expect(evo.connect(a).evolve(v, sig, { value: FULL })).to.emit(evo, "Evolved");
  });

  it("holds no money: a payment that can't reach the treasury, or re-enters from it, fails whole", async () => {
    const { owner, a, cards, serverKey } = await deploy();
    const bad = await ethers.deployContract("HostileTreasury");
    const evo = await ethers.deployContract("CardEvolution", [owner.address, await cards.getAddress(), await bad.getAddress(), serverKey.address, FULL]);
    const domain = { name: "CardEvolution", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await evo.getAddress() };
    const v = { holder: a.address, id: 7, stage: 1, side: LIGHT, price: FULL, expiry: (await time.latest()) + 600 };
    const sig = await serverKey.signTypedData(domain, TYPES, v);
    await expect(evo.connect(a).evolve(v, sig, { value: FULL })).to.be.revertedWithCustomError(evo, "PaymentFailed");
    await bad.arm(await evo.getAddress(), v, sig);
    await expect(evo.connect(a).evolve(v, sig, { value: FULL })).to.be.revertedWithCustomError(evo, "PaymentFailed");
    expect(await evo.stageOf(7)).to.equal(0);
    expect(await ethers.provider.getBalance(await evo.getAddress())).to.equal(0n);
    await expect(a.sendTransaction({ to: await evo.getAddress(), value: 1n })).to.be.reverted;
  });

  it("ownership waits 48 hours, can't be renounced, and a new owner inherits no proposal", async () => {
    const { owner, other, evo } = await deploy();
    await expect(evo.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(evo, "NoRenounce");
    await evo.connect(owner).proposeMaxPrice(2, FULL);
    await evo.connect(owner).proposeMaxPrice(9, FULL);
    await evo.connect(owner).transferOwnership(other.address);
    await expect(evo.connect(other).acceptOwnership()).to.be.revertedWithCustomError(evo, "NotReady");
    await time.increase(TIMELOCK);
    await evo.connect(other).acceptOwnership();
    expect(await evo.owner()).to.equal(other.address);
    await expect(evo.connect(other).execute(MAX_PRICE, 2)).to.be.revertedWithCustomError(evo, "NotReady");
    await expect(evo.connect(other).execute(MAX_PRICE, 9)).to.be.revertedWithCustomError(evo, "NotReady");
    expect(await evo.maxPrice(2)).to.equal(0n);
  });
});
