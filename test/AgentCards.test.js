const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const IMG = "https://cards.test/api/card/";
const SITE = "https://cards.test/card/";
const DAY = 86400;
const LABEL = "nova";
const agentIdOf = (label) => BigInt(ethers.id(label)); // the registry's token id for a name

const LINKS = { imageBase: IMG, imageSuffix: ".svg", siteBase: SITE, animationBase: "", animationSuffix: "" };
const TIMELOCK = 48 * 3600;
const Setting = {
  Treasury: 0, Signer: 1, VoucherSigner: 2, Renderer: 3, MarketFee: 4, Operator: 5, FightPackPrice: 6, PassPrice: 7, MythicPrice: 8,
};

// `owner` is the human-held wallet (My Wallet on mainnet); `operator` is the agent's wallet doing routine upkeep
async function deploy() {
  const [owner, agent, other, treasury, operator] = await ethers.getSigners();
  const signer = ethers.Wallet.createRandom();
  const voucherSigner = ethers.Wallet.createRandom();
  const registry = await ethers.deployContract("MockRegistry");
  const renderer = await ethers.deployContract("CardRenderer", [owner.address, LINKS]);
  const cards = await ethers.deployContract("AgentCards", [
    owner.address, operator.address, treasury.address, signer.address, voucherSigner.address,
    await registry.getAddress(), await renderer.getAddress(),
  ]);
  await registry.register(agent.address, LABEL);
  return { owner, operator, agent, other, treasury, signer, voucherSigner, registry, renderer, cards };
}

// a Mythic design for the permission tests
const DESIGN = {
  name: "Plum Blossom Saint", region: 1, role: 4, season: 1, open: true, power: 46, defense: 46, speed: 73, luck: 61,
  saleSupply: 45, sold: 0, wheelReserve: 5, awarded: 0, price: ethers.parseEther("0.05"),
};

/** Proposes a timelocked setting, waits the 48 hours out and applies it. */
async function setLater(cards, owner, setting, value) {
  await cards.connect(owner).propose(setting, value);
  await time.increase(TIMELOCK);
  await cards.connect(owner).execute(setting);
}

async function domain(cards) {
  const { chainId } = await ethers.provider.getNetwork();
  return { name: "AgentCards", version: "1", chainId, verifyingContract: await cards.getAddress() };
}

async function stats(cards, signer, wallet, over = {}) {
  const now = await time.latest();
  const s = {
    wallet, label: LABEL, power: 40, defense: 55, speed: 70, luck: 30, role: 1, region: 0,
    badges: 0b100011, roll: 5_000, issuedAt: now, expiry: now + 600, ...over,
  };
  const types = {
    Stats: [
      { name: "wallet", type: "address" }, { name: "label", type: "string" },
      { name: "power", type: "uint8" }, { name: "defense", type: "uint8" }, { name: "speed", type: "uint8" },
      { name: "luck", type: "uint8" }, { name: "role", type: "uint8" }, { name: "region", type: "uint8" },
      { name: "badges", type: "uint32" }, { name: "roll", type: "uint32" },
      { name: "issuedAt", type: "uint64" }, { name: "expiry", type: "uint64" },
    ],
  };
  return [s, await signer.signTypedData(await domain(cards), types, s)];
}

async function update(cards, signer, id, over = {}) {
  const now = await time.latest();
  const u = { id, level: 2, badges: 0b100011, issuedAt: now + 1, expiry: now + 600, ...over };
  const types = {
    Update: [
      { name: "id", type: "uint256" }, { name: "level", type: "uint16" }, { name: "badges", type: "uint32" },
      { name: "issuedAt", type: "uint64" }, { name: "expiry", type: "uint64" },
    ],
  };
  return [u, await signer.signTypedData(await domain(cards), types, u)];
}

function decode(uri) {
  const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
  const trait = (t) => json.attributes.filter((a) => a.trait_type === t).map((a) => a.value);
  return { json, trait };
}

describe("AgentCards", () => {
  it("mints one free card for an Agent ID, named after it, and describes it", async () => {
    const { agent, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await expect(cards.connect(agent).mint(s, sig))
      .to.emit(cards, "CardMinted").withArgs(1, agent.address, agentIdOf(LABEL), "nova.ai", 1, false);
    expect(await cards.ownerOf(1)).to.equal(agent.address);
    expect(await cards.cardOfAgentId(agentIdOf(LABEL))).to.equal(1n);
    const c = await cards.card(1);
    expect(c.name).to.equal("nova.ai");
    expect(c.power).to.equal(40n);
    expect(c.mintedAt).to.equal(c.updatedAt);
    const { json, trait } = decode(await cards.tokenURI(1));
    expect(json.name).to.equal("nova.ai #1");
    expect(json.image).to.equal(`${IMG}1.svg?v=${c.updatedAt}`);
    expect(json.external_url).to.equal(`${SITE}1`);
    expect(trait("Role")).to.deep.equal(["Warrior"]);
    expect(trait("Region")).to.deep.equal(["West"]);
    expect(trait("Class")).to.deep.equal(["Paladin"]);
    expect(trait("Rarity")).to.deep.equal(["Rare"]);
    expect(trait("Level")).to.deep.equal([1]);
    expect(trait("Badge")).to.deep.equal(["RUNES", "COLO", "CROLL"]);
  });

  it("lets only the wallet holding the Agent ID mint it", async () => {
    const { agent, other, signer, registry, cards } = await deploy();
    const [taken, takenSig] = await stats(cards, signer, other.address); // "nova" belongs to agent
    await expect(cards.connect(other).mint(taken, takenSig)).to.be.revertedWithCustomError(cards, "NotAgent");
    const [unknown, unknownSig] = await stats(cards, signer, other.address, { label: "nobody" });
    await expect(cards.connect(other).mint(unknown, unknownSig)).to.be.revertedWithCustomError(cards, "NotAgent");
    await registry.register(other.address, "bob");
    const [foreign, foreignSig] = await stats(cards, signer, agent.address); // signed for agent, sent by other
    await expect(cards.connect(other).mint(foreign, foreignSig)).to.be.revertedWithCustomError(cards, "NotAgent");
  });

  it("allows one card per Agent ID, even after the ID changes wallets", async () => {
    const { agent, other, signer, registry, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    await expect(cards.connect(agent).mint(s, sig)).to.be.revertedWithCustomError(cards, "AlreadyMinted");
    await registry.connect(agent).transferFrom(agent.address, other.address, agentIdOf(LABEL));
    const [moved, movedSig] = await stats(cards, signer, other.address);
    await expect(cards.connect(other).mint(moved, movedSig)).to.be.revertedWithCustomError(cards, "AlreadyMinted");
    await registry.register(agent.address, "nova2"); // a second Agent ID gets its own card
    const [second, secondSig] = await stats(cards, signer, agent.address, { label: "nova2" });
    await cards.connect(agent).mint(second, secondSig);
    expect(await cards.cardOfAgentId(agentIdOf("nova2"))).to.equal(2n);
  });

  it("rejects a wrong signer, expired stats and tampered stats or rolls", async () => {
    const { agent, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    const [, badSig] = await stats(cards, ethers.Wallet.createRandom(), agent.address);
    await expect(cards.connect(agent).mint(s, badSig)).to.be.revertedWithCustomError(cards, "BadSignature");
    await expect(cards.connect(agent).mint({ ...s, power: 99 }, sig)).to.be.revertedWithCustomError(cards, "BadSignature");
    await expect(cards.connect(agent).mint({ ...s, roll: 0 }, sig)).to.be.revertedWithCustomError(cards, "BadSignature");
    const [old, oldSig] = await stats(cards, signer, agent.address, { expiry: (await time.latest()) - 1 });
    await expect(cards.connect(agent).mint(old, oldSig)).to.be.revertedWithCustomError(cards, "Expired");
  });

  it("rejects out-of-range stats and unsafe names even when signed", async () => {
    const { agent, signer, cards } = await deploy();
    for (const over of [{ power: 0 }, { luck: 100 }, { role: 0 }, { role: 5 }]) {
      const [s, sig] = await stats(cards, signer, agent.address, over);
      await expect(cards.connect(agent).mint(s, sig)).to.be.revertedWithCustomError(cards, "BadStats");
    }
    for (const label of ["", "Nova", "nova.ai", "<script>", 'a"b', "a".repeat(30)]) {
      const [s, sig] = await stats(cards, signer, agent.address, { label });
      await expect(cards.connect(agent).mint(s, sig)).to.be.revertedWithCustomError(cards, "BadName");
    }
  });

  it("takes rarity from the secret roll and mint order, never worse for minting earlier", async () => {
    const { cards } = await deploy();
    const cases = [ // [card id, roll, rarity]: the edges of every phase
      [1, 999, 3], [1, 1_000, 2], [1, 4_499, 2], [1, 4_500, 1], [1, 8_699, 1], [1, 8_700, 0],
      [100, 999, 3], [101, 999, 2], [101, 299, 3], [1_000, 6_299, 1], [1_001, 6_299, 0],
      [5_000, 199, 3], [5_001, 199, 2], [5_001, 99, 3], [9_999, 599, 2], [9_999, 3_599, 1], [9_999, 3_600, 0],
      [1, 1_230_999, 3], // only the last four digits pick rarity
    ];
    for (const [id, roll, rarity] of cases) expect((await cards.rarityOf(roll, id)).rarity).to.equal(BigInt(rarity));
    for (let roll = 0; roll < 10_000; roll += 97) {
      let prev = 3n;
      for (const id of [1, 101, 1_001, 5_001]) {
        const { rarity } = await cards.rarityOf(roll, id);
        expect(rarity).to.be.lte(prev);
        prev = rarity;
      }
    }
    // the two digits before them awaken 30% of Epic and Legendary cards
    expect((await cards.rarityOf(290_999, 1)).awakened).to.equal(true);
    expect((await cards.rarityOf(300_999, 1)).awakened).to.equal(false);
    expect((await cards.rarityOf(8_700, 1)).awakened).to.equal(false); // Common never awakens
    expect((await cards.rarityOf(108_699, 1)).awakened).to.equal(false); // nor does Rare
  });

  it("mints an awakened East Assassin as a Blind Sword Master", async () => {
    const { agent, signer, cards, renderer } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address, { role: 4, region: 1, roll: 100_500 });
    await cards.connect(agent).mint(s, sig);
    const c = await cards.card(1);
    expect([c.rarity, c.awakened]).to.deep.equal([3n, true]);
    expect(decode(await cards.tokenURI(1)).trait("Class")).to.deep.equal(["Blind Sword Master"]);
    expect(await renderer.className(1, 4, false)).to.equal("Plum Blossom Swordsman");
    expect(await renderer.className(0, 4, true)).to.equal("Shadow Blade"); // no hidden class for it yet
  });

  it("applies signed levels without touching identity, stats, role or rarity", async () => {
    const { agent, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    const before = await cards.card(1);
    const [u, uSig] = await update(cards, signer, 1, { level: 10, badges: 1 });
    await expect(cards.connect(agent).update(u, uSig)).to.emit(cards, "CardUpdated").withArgs(1, 10);
    const c = await cards.card(1);
    expect([c.level, c.badges]).to.deep.equal([10n, 1n]);
    const fixed = (x) => [x.name, x.agent, x.power, x.defense, x.speed, x.luck, x.role, x.region, x.rarity, x.awakened, x.mintedAt];
    expect(fixed(c)).to.deep.equal(fixed(before));
    const { json, trait } = decode(await cards.tokenURI(1));
    expect(trait("Level")).to.deep.equal([10]);
    expect(json.image).to.equal(`${IMG}1.svg?v=${u.issuedAt}`); // new URL so marketplaces refetch
  });

  it("never lowers a level or lets it run ahead of the card's age", async () => {
    const { agent, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    expect(await cards.levelCap(1)).to.equal(10n);
    const [early, earlySig] = await update(cards, signer, 1, { level: 11 });
    await expect(cards.connect(agent).update(early, earlySig)).to.be.revertedWithCustomError(cards, "BadLevel");
    await time.increase(3 * DAY);
    expect(await cards.levelCap(1)).to.equal(22n);
    const [u1, u1Sig] = await update(cards, signer, 1, { level: 22 });
    await cards.connect(agent).update(u1, u1Sig);
    const [lower, lowerSig] = await update(cards, signer, 1, { level: 21 });
    await expect(cards.connect(agent).update(lower, lowerSig)).to.be.revertedWithCustomError(cards, "BadLevel");
    const [same, sameSig] = await update(cards, signer, 1, { level: 22, badges: 0 }); // badges only
    await cards.connect(agent).update(same, sameSig);
    expect((await cards.card(1)).badges).to.equal(0n);
    // however old the card gets, it never shows more than the game's top level, even with the signer's key
    await time.increase(60 * DAY);
    expect(await cards.levelCap(1)).to.equal(50n);
    const [past, pastSig] = await update(cards, signer, 1, { level: 51 });
    await expect(cards.connect(agent).update(past, pastSig)).to.be.revertedWithCustomError(cards, "BadLevel");
    const [top, topSig] = await update(cards, signer, 1, { level: 50 });
    await cards.connect(agent).update(top, topSig);
    expect((await cards.card(1)).level).to.equal(50n);
  });

  it("stops signed level updates at once when the operator pauses them; only the owner reopens them", async () => {
    const { owner, operator, agent, other, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    expect(await cards.updatesOpen()).to.equal(true);
    await expect(cards.connect(other).pauseUpdates()).to.be.revertedWithCustomError(cards, "NotOperator");
    await expect(cards.connect(operator).pauseUpdates()).to.emit(cards, "ConfigSet");
    const [u, uSig] = await update(cards, signer, 1, { level: 5 });
    await expect(cards.connect(agent).update(u, uSig)).to.be.revertedWithCustomError(cards, "UpdatesClosed");
    expect(await cards.mintOpen()).to.equal(true); // the mint has its own brake
    await expect(cards.connect(operator).setUpdatesOpen(true)).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    await cards.connect(owner).setUpdatesOpen(true);
    await cards.connect(agent).update(u, uSig);
    expect((await cards.card(1)).level).to.equal(5n);
  });

  it("rejects stale, replayed, forged and expired updates", async () => {
    const { agent, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    const [u1, u1Sig] = await update(cards, signer, 1, { level: 5 });
    await cards.connect(agent).update(u1, u1Sig);
    await expect(cards.connect(agent).update(u1, u1Sig)).to.be.revertedWithCustomError(cards, "StaleUpdate");
    const [old, oldSig] = await update(cards, signer, 1, { level: 9, issuedAt: u1.issuedAt });
    await expect(cards.connect(agent).update(old, oldSig)).to.be.revertedWithCustomError(cards, "StaleUpdate");
    const [forged, forgedSig] = await update(cards, ethers.Wallet.createRandom(), 1, { level: 9 });
    await expect(cards.connect(agent).update(forged, forgedSig)).to.be.revertedWithCustomError(cards, "BadSignature");
    const [late, lateSig] = await update(cards, signer, 1, { expiry: (await time.latest()) - 1 });
    await expect(cards.connect(agent).update(late, lateSig)).to.be.revertedWithCustomError(cards, "Expired");
  });

  it("moves the character with the card: only the current holder can apply updates", async () => {
    const { agent, other, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    const [u1, u1Sig] = await update(cards, signer, 1, { level: 8 });
    await cards.connect(agent).update(u1, u1Sig);
    await cards.connect(agent).transferFrom(agent.address, other.address, 1);
    expect((await cards.card(1)).level).to.equal(8n);
    await time.increase(DAY);
    const [u2, u2Sig] = await update(cards, signer, 1, { level: 13 });
    await expect(cards.connect(agent).update(u2, u2Sig)).to.be.revertedWithCustomError(cards, "NotCardOwner");
    await cards.connect(other).update(u2, u2Sig);
    expect((await cards.card(1)).level).to.equal(13n);
  });

  it("sells neither Holo nor frames: nothing takes a payment for them, and only upkeep grants them", async () => {
    const { owner, operator, agent, other, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    const fns = cards.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    for (const gone of ["holo", "holoPrice", "setHoloPrice", "setFrame", "framePrice", "setFramePrice"]) expect(fns).to.not.include(gone);
    // the calldata of the old sales, sent with BNB, finds no function to run
    const old = new ethers.Interface(["function holo(uint256 id) payable", "function setFrame(uint256 id, uint16 frame) payable"]);
    const to = await cards.getAddress();
    await expect(other.sendTransaction({ to, data: old.encodeFunctionData("holo", [1]), value: ethers.parseEther("0.01") })).to.be.reverted;
    await expect(agent.sendTransaction({ to, data: old.encodeFunctionData("setFrame", [1, 1]), value: ethers.parseEther("0.003") })).to.be.reverted;
    expect([(await cards.card(1)).holo, (await cards.card(1)).frame]).to.deep.equal([false, 0n]);
    // both come for free, from the operator's upkeep (or the owner)
    await expect(cards.connect(operator).grantHolo([1])).to.emit(cards, "HoloApplied").withArgs(1, operator.address);
    await expect(cards.connect(owner).grantFrame([1], 1)).to.emit(cards, "FrameApplied").withArgs(1, 1);
    const { trait } = decode(await cards.tokenURI(1));
    expect([trait("Holo"), trait("Frame")]).to.deep.equal([["Yes"], ["Gold"]]);
    expect(await ethers.provider.getBalance(to)).to.equal(0n);
  });

  it("lets the owner or the operator grant free holo for promotions", async () => {
    const { owner, operator, agent, other, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    await expect(cards.connect(other).grantHolo([1])).to.be.revertedWithCustomError(cards, "NotOperator");
    await cards.connect(operator).grantHolo([1, 1]);
    expect((await cards.card(1)).holo).to.equal(true);
    await expect(cards.connect(owner).grantHolo([1])).to.not.be.reverted; // already holo: skipped
  });

  it("lets only the owner change settings and pays royalties to the treasury", async () => {
    const { owner, agent, other, treasury, signer, cards } = await deploy();
    await expect(cards.connect(other).setMintOpen(false)).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    await cards.connect(owner).setMintOpen(false);
    const [s, sig] = await stats(cards, signer, agent.address);
    await expect(cards.connect(agent).mint(s, sig)).to.be.revertedWithCustomError(cards, "MintClosed");
    const [recv, amount] = await cards.royaltyInfo(1, ethers.parseEther("1"));
    expect(recv).to.equal(treasury.address);
    expect(amount).to.equal(ethers.parseEther("0.05"));
  });

  it("mints into the four open regions only, and the owner controls which are open", async () => {
    const { owner, agent, other, signer, cards } = await deploy();
    const [fifth, fifthSig] = await stats(cards, signer, agent.address, { region: 4 });
    await expect(cards.connect(agent).mint(fifth, fifthSig)).to.be.revertedWithCustomError(cards, "RegionClosed");
    await expect(cards.connect(other).setOpenRegions(3)).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    await cards.connect(owner).setOpenRegions(3);
    const [north, northSig] = await stats(cards, signer, agent.address, { region: 2 });
    await expect(cards.connect(agent).mint(north, northSig)).to.be.revertedWithCustomError(cards, "RegionClosed");
    await cards.connect(owner).setOpenRegions(15);
    await cards.connect(agent).mint(north, northSig);
    const { trait } = decode(await cards.tokenURI(1));
    expect(trait("Region")).to.deep.equal(["North"]);
    expect(trait("Class")).to.deep.equal(["Berserker"]);
  });

  it("lets only the owner move the art host, and only 48 hours after proposing it", async () => {
    const { owner, other, renderer } = await deploy();
    const next = { ...LINKS, imageBase: "ipfs://art/", imageSuffix: ".png", siteBase: "https://new.test/card/" };
    await expect(renderer.connect(other).proposeLinks(next)).to.be.revertedWithCustomError(renderer, "OwnableUnauthorizedAccount");
    await expect(renderer.connect(owner).proposeLinks(next)).to.emit(renderer, "LinksProposed");
    await expect(renderer.connect(owner).executeLinks()).to.be.revertedWithCustomError(renderer, "NotReady");
    expect(await renderer.imageBase()).to.equal(IMG);
    await time.increase(TIMELOCK);
    await expect(renderer.connect(other).executeLinks()).to.be.revertedWithCustomError(renderer, "OwnableUnauthorizedAccount");
    await expect(renderer.connect(owner).executeLinks()).to.emit(renderer, "LinksChanged");
    expect(await renderer.imageBase()).to.equal("ipfs://art/");
    expect(await renderer.linksEta()).to.equal(0n);
    // a cancelled proposal can't be applied
    await renderer.connect(owner).proposeLinks(LINKS);
    await expect(renderer.connect(owner).cancelLinks()).to.emit(renderer, "LinksCancelled");
    await time.increase(TIMELOCK);
    await expect(renderer.connect(owner).executeLinks()).to.be.revertedWithCustomError(renderer, "NotReady");
    await expect(renderer.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(renderer, "RenounceDisabled");
  });

  it("reverts the whole payment when the treasury refuses it", async () => {
    const { owner, agent, signer, cards } = await deploy();
    const pass = ethers.parseEther("0.02");
    await cards.connect(owner).setPassPrice(pass); // a launch price, set before the first card
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    const bad = await ethers.deployContract("RejectingTreasury");
    await setLater(cards, owner, Setting.Treasury, await bad.getAddress());
    await expect(cards.connect(agent).buyPass(1, { value: pass })).to.be.revertedWithCustomError(cards, "PaymentFailed");
  });

  it("holds every money or key setting 48 hours between proposal and use, and lets the owner cancel", async () => {
    const { owner, other, treasury, voucherSigner, cards } = await deploy();
    const thief = other.address;
    await expect(cards.connect(other).propose(Setting.Treasury, thief)).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    const tx = cards.connect(owner).propose(Setting.Treasury, thief);
    await expect(tx).to.emit(cards, "SettingProposed");
    expect((await cards.pending(Setting.Treasury, 0)).value).to.equal(BigInt(thief));
    await expect(cards.connect(owner).execute(Setting.Treasury)).to.be.revertedWithCustomError(cards, "NotReady");
    await time.increase(TIMELOCK - 60);
    await expect(cards.connect(owner).execute(Setting.Treasury)).to.be.revertedWithCustomError(cards, "NotReady");
    await expect(cards.connect(owner).cancel(Setting.Treasury)).to.emit(cards, "SettingCancelled").withArgs(Setting.Treasury, 0);
    await time.increase(120);
    await expect(cards.connect(owner).execute(Setting.Treasury)).to.be.revertedWithCustomError(cards, "NotReady");
    expect(await cards.treasury()).to.equal(treasury.address);
    // a real change goes through after the wait, and the royalty follows the treasury
    await setLater(cards, owner, Setting.Treasury, other.address);
    expect(await cards.treasury()).to.equal(other.address);
    expect((await cards.royaltyInfo(1, 10_000))[0]).to.equal(other.address);
    const fresh = ethers.Wallet.createRandom().address;
    await setLater(cards, owner, Setting.Signer, fresh);
    expect(await cards.signer()).to.equal(fresh);
    await setLater(cards, owner, Setting.VoucherSigner, fresh);
    expect(await cards.voucherSigner()).to.equal(fresh);
    await expect(cards.connect(owner).propose(Setting.Signer, 0)).to.be.revertedWithCustomError(cards, "BadSetting");
    await expect(cards.connect(owner).propose(Setting.Renderer, 1n << 160n)).to.be.revertedWithCustomError(cards, "BadSetting");
    expect(await cards.voucherSigner()).to.not.equal(voucherSigner.address);
  });

  it("moves ownership only in two steps, 48 hours apart, and never renounces it", async () => {
    const { owner, other, cards } = await deploy();
    await expect(cards.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(cards, "RenounceDisabled");
    await expect(cards.connect(owner).transferOwnership(other.address)).to.emit(cards, "OwnershipProposed");
    expect(await cards.owner()).to.equal(owner.address); // nothing changes until the new owner accepts
    expect(await cards.pendingOwner()).to.equal(other.address);
    await expect(cards.connect(other).acceptOwnership()).to.be.revertedWithCustomError(cards, "NotReady"); // not before the wait
    // the owner can cancel during the wait, and a cancelled transfer can't be accepted later
    await cards.connect(owner).transferOwnership("0x0000000000000000000000000000000000000000");
    await time.increase(TIMELOCK);
    await expect(cards.connect(other).acceptOwnership()).to.be.revertedWithCustomError(cards, "NotReady");
    await cards.connect(owner).transferOwnership(other.address);
    await time.increase(TIMELOCK);
    await cards.connect(other).acceptOwnership();
    expect([await cards.owner(), await cards.ownerEta()]).to.deep.equal([other.address, 0n]);
  });

  it("gives the operator routine upkeep only: no money, prices, keys, Mythic designs or ownership", async () => {
    const { owner, operator, agent, other, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    await cards.connect(owner).addMythic(DESIGN);
    expect(await cards.operator()).to.equal(operator.address);

    // upkeep the operator (and the owner) can do; a stranger can't
    for (const who of [other, agent]) {
      await expect(cards.connect(who).pauseMint()).to.be.revertedWithCustomError(cards, "NotOperator");
      await expect(cards.connect(who).pauseUpdates()).to.be.revertedWithCustomError(cards, "NotOperator");
      await expect(cards.connect(who).grantFrame([1], 1)).to.be.revertedWithCustomError(cards, "NotOperator");
      await expect(cards.connect(who).capMythic(1, 40, 5)).to.be.revertedWithCustomError(cards, "NotOperator");
    }
    await expect(cards.connect(operator).grantFrame([1], 2)).to.emit(cards, "FrameApplied").withArgs(1, 2);
    await expect(cards.connect(operator).capMythic(1, 40, 5)).to.emit(cards, "MythicCapped").withArgs(1, 40, 5);
    await expect(cards.connect(operator).capMythic(1, 41, 5)).to.be.revertedWithCustomError(cards, "BadSupply"); // never grows
    await expect(cards.connect(operator).pauseMint()).to.emit(cards, "ConfigSet");
    expect(await cards.mintOpen()).to.equal(false);

    // everything else stays with the owner, the operator included
    const op = cards.connect(operator);
    const ownerOnly = [
      () => op.setMintOpen(true), () => op.setUpdatesOpen(true), // the operator can stop the mint and updates, never reopen them
      () => op.setFightPackPrice(1), () => op.setPassPrice(1), () => op.setOpenRegions(1),
      () => op.addMythic(DESIGN), () => op.addMythics([DESIGN]), () => op.setMythicSale(1, 1, true),
      () => op.propose(Setting.Treasury, operator.address), () => op.propose(Setting.FightPackPrice, 1), () => op.proposeMythicPrice(1, 1),
      () => op.cancel(Setting.Treasury), () => op.cancelMythicPrice(1), () => op.execute(Setting.Treasury), () => op.executeMythicPrice(1),
      () => op.revokeOperator(), () => op.transferOwnership(operator.address),
    ];
    for (const call of ownerOnly) await expect(call()).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    await cards.connect(owner).setMintOpen(true);
    expect(await cards.mintOpen()).to.equal(true);
  });

  it("revokes the operator at once, and sets a new one only 48 hours after proposing it", async () => {
    const { owner, operator, other, cards } = await deploy();
    await expect(cards.connect(owner).propose(Setting.Operator, 0)).to.be.revertedWithCustomError(cards, "BadSetting");
    await cards.connect(owner).propose(Setting.Operator, other.address);
    await expect(cards.connect(owner).execute(Setting.Operator)).to.be.revertedWithCustomError(cards, "NotReady");
    // revoking is immediate and drops the pending proposal too
    await expect(cards.connect(owner).revokeOperator())
      .to.emit(cards, "SettingCancelled").withArgs(Setting.Operator, 0)
      .and.to.emit(cards, "SettingChanged").withArgs(Setting.Operator, 0, 0);
    expect(await cards.operator()).to.equal(ethers.ZeroAddress);
    expect((await cards.pending(Setting.Operator, 0)).eta).to.equal(0n);
    await expect(cards.connect(operator).pauseMint()).to.be.revertedWithCustomError(cards, "NotOperator");
    await time.increase(TIMELOCK);
    await expect(cards.connect(owner).execute(Setting.Operator)).to.be.revertedWithCustomError(cards, "NotReady");
    // a new operator waits the full 48 hours
    await setLater(cards, owner, Setting.Operator, other.address);
    expect(await cards.operator()).to.equal(other.address);
    await expect(cards.connect(other).pauseMint()).to.not.be.reverted;
  });

  it("adds a season's Mythic designs in one owner transaction", async () => {
    const { owner, cards } = await deploy();
    const second = { ...DESIGN, name: "Dawnforged Seraph", region: 0, role: 1 };
    await expect(cards.connect(owner).addMythics([DESIGN, second]))
      .to.emit(cards, "MythicAdded").withArgs(1, DESIGN.name, 50, DESIGN.price)
      .and.to.emit(cards, "MythicAdded").withArgs(2, second.name, 50, DESIGN.price);
    expect(await cards.mythicDesigns()).to.equal(2n);
    await expect(cards.connect(owner).addMythics([{ ...DESIGN, power: 99, defense: 99 }])).to.be.revertedWithCustomError(cards, "BadStats");
  });

  it("drops every pending proposal when ownership changes hands, and lists them all", async () => {
    const { owner, operator, other, cards } = await deploy();
    await cards.connect(owner).addMythic(DESIGN);
    await cards.connect(owner).propose(Setting.Treasury, other.address);
    await cards.connect(owner).propose(Setting.Signer, other.address);
    await cards.connect(owner).propose(Setting.MarketFee, 500);
    await cards.connect(owner).propose(Setting.Operator, other.address);
    await cards.connect(owner).propose(Setting.FightPackPrice, 9);
    await cards.connect(owner).proposeMythicPrice(1, 11);
    let [settings, mythicPrices] = await cards.allPending();
    expect([settings.length, mythicPrices.length]).to.deep.equal([8, 1]); // every setting but MythicPrice, then each design's price
    expect(settings.map((p) => p.eta > 0n)).to.deep.equal([true, true, false, false, true, true, true, false]);
    expect([settings[Setting.MarketFee].value, settings[Setting.FightPackPrice].value, mythicPrices[0].value]).to.deep.equal([500n, 9n, 11n]);

    await cards.connect(owner).transferOwnership(other.address);
    expect((await cards.allPending())[0][Setting.Treasury].eta).to.not.equal(0n); // still queued until the handover
    await time.increase(TIMELOCK); // the handover itself waits 48 hours
    const accept = cards.connect(other).acceptOwnership();
    for (const s of [Setting.Treasury, Setting.Signer, Setting.MarketFee, Setting.Operator, Setting.FightPackPrice]) {
      await expect(accept).to.emit(cards, "SettingCancelled").withArgs(s, 0);
    }
    await expect(accept).to.emit(cards, "SettingCancelled").withArgs(Setting.MythicPrice, 1);
    [settings, mythicPrices] = await cards.allPending();
    expect([...settings, ...mythicPrices].every((p) => p.eta === 0n && p.value === 0n)).to.equal(true);
    await time.increase(TIMELOCK);
    await expect(cards.connect(other).execute(Setting.Treasury)).to.be.revertedWithCustomError(cards, "NotReady");
    await expect(cards.connect(other).executeMythicPrice(1)).to.be.revertedWithCustomError(cards, "NotReady");
    // the old owner is out; the operator stays (the new owner can revoke it at once)
    await expect(cards.connect(owner).setMintOpen(false)).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    expect(await cards.operator()).to.equal(operator.address);
  });

  it("keeps renderer links from breaking the metadata, and drops proposed links on a new owner", async () => {
    const { owner, other, renderer } = await deploy();
    const bad = ['https://x.test/"},{"a":"', "https://x.test/\\u0022", "https://x.test/a b", "https://x.test/\n",
      `https://x.test/${"a".repeat(190)}`, "https://x.test/é"];
    for (const link of bad) {
      await expect(renderer.connect(owner).proposeLinks({ ...LINKS, animationBase: link }))
        .to.be.revertedWithCustomError(renderer, "BadLink");
    }
    await expect(ethers.deployContract("CardRenderer", [owner.address, { ...LINKS, siteBase: 'x"y' }]))
      .to.be.revertedWithCustomError(renderer, "BadLink");
    const fine = { ...LINKS, animationBase: "https://cards.test/card/", animationSuffix: "/live?x=1&y=%20" };
    await expect(renderer.connect(owner).proposeLinks(fine)).to.emit(renderer, "LinksProposed");
    // a new owner doesn't inherit the old owner's queued links
    await renderer.connect(owner).transferOwnership(other.address);
    await expect(renderer.connect(other).acceptOwnership()).to.be.revertedWithCustomError(renderer, "NotReady"); // 48 hours first
    await time.increase(TIMELOCK);
    await expect(renderer.connect(other).acceptOwnership()).to.emit(renderer, "LinksCancelled");
    expect(await renderer.linksEta()).to.equal(0n);
    await time.increase(TIMELOCK);
    await expect(renderer.connect(other).executeLinks()).to.be.revertedWithCustomError(renderer, "NotReady");
    expect(await renderer.animationBase()).to.equal("");
  });

  it("logs every owner setting", async () => {
    const { owner, cards } = await deploy();
    const key = (s) => ethers.encodeBytes32String(s);
    await expect(cards.connect(owner).setMintOpen(false)).to.emit(cards, "ConfigSet").withArgs(key("mintOpen"), 0, 0);
    await expect(cards.connect(owner).setUpdatesOpen(false)).to.emit(cards, "ConfigSet").withArgs(key("updatesOpen"), 0, 0);
    // the launch prices, before the first card (later ones log SettingProposed and SettingChanged)
    await expect(cards.connect(owner).setFightPackPrice(5)).to.emit(cards, "ConfigSet").withArgs(key("fightPackPrice"), 5, 0);
    await expect(cards.connect(owner).setPassPrice(7)).to.emit(cards, "ConfigSet").withArgs(key("passPrice"), 7, 0);
    await expect(cards.connect(owner).setOpenRegions(3)).to.emit(cards, "ConfigSet").withArgs(key("openRegions"), 3, 0);
  });

  it("caps signed stats at what a minted card can reach (226 in total)", async () => {
    const { agent, signer, cards } = await deploy();
    const [big, bigSig] = await stats(cards, signer, agent.address, { power: 99, defense: 99, speed: 99, luck: 99 });
    await expect(cards.connect(agent).mint(big, bigSig)).to.be.revertedWithCustomError(cards, "BadStats");
    const [over, overSig] = await stats(cards, signer, agent.address, { power: 57, defense: 57, speed: 57, luck: 56 }); // 227
    await expect(cards.connect(agent).mint(over, overSig)).to.be.revertedWithCustomError(cards, "BadStats");
    const [max, maxSig] = await stats(cards, signer, agent.address, { power: 57, defense: 57, speed: 56, luck: 56 }); // 226
    await expect(cards.connect(agent).mint(max, maxSig)).to.emit(cards, "CardMinted");
  });

  it("refuses a level update dated in the future, which would freeze the card's level", async () => {
    const { agent, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    const now = await time.latest();
    const [far, farSig] = await update(cards, signer, 1, { issuedAt: now + 10 * DAY, expiry: now + 600 });
    await expect(cards.connect(agent).update(far, farSig)).to.be.revertedWithCustomError(cards, "FutureUpdate");
    const [soon, soonSig] = await update(cards, signer, 1, { issuedAt: now + 1800, expiry: now + 600 }); // within the hour
    await expect(cards.connect(agent).update(soon, soonSig)).to.emit(cards, "CardUpdated");
  });

  it("counts every card, Mythic copies included, in totalCards", async () => {
    const { agent, signer, cards } = await deploy();
    expect(await cards.totalCards()).to.equal(0n);
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    expect(await cards.totalCards()).to.equal(1n);
  });

  it("sells packs of extra fights at the set price and forwards the payment", async () => {
    const { owner, agent, other, treasury, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    const pack = ethers.parseEther("0.003");
    await expect(cards.connect(other).buyFights(1, 1, { value: pack })).to.be.revertedWithCustomError(cards, "WrongPrice"); // not for sale yet
    await expect(cards.connect(other).setFightPackPrice(pack)).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    await expect(cards.connect(other).propose(Setting.FightPackPrice, pack)).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    await setLater(cards, owner, Setting.FightPackPrice, pack); // a card exists, so the price waits 48 hours
    const bought = cards.connect(other).buyFights(1, 3, { value: pack * 3n });
    await expect(bought).to.emit(cards, "FightsBought").withArgs(1, other.address, 3);
    await expect(bought).to.changeEtherBalances([other, treasury], [-pack * 3n, pack * 3n]);
    await expect(cards.connect(other).buyFights(1, 3, { value: pack })).to.be.revertedWithCustomError(cards, "WrongPrice");
    await expect(cards.connect(other).buyFights(1, 0, { value: 0 })).to.be.revertedWithCustomError(cards, "WrongPrice");
    await expect(cards.connect(other).buyFights(7, 1, { value: pack })).to.be.revertedWithCustomError(cards, "ERC721NonexistentToken");
    expect(await ethers.provider.getBalance(await cards.getAddress())).to.equal(0n);
  });

  it("sells a season pass for a card at the set price and forwards the payment", async () => {
    const { owner, agent, other, treasury, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    const pass = ethers.parseEther("0.02");
    await expect(cards.connect(other).buyPass(1, { value: 0 })).to.be.revertedWithCustomError(cards, "WrongPrice"); // not for sale yet
    await expect(cards.connect(other).buyPass(1, { value: pass })).to.be.revertedWithCustomError(cards, "WrongPrice");
    await expect(cards.connect(other).setPassPrice(pass)).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    await setLater(cards, owner, Setting.PassPrice, pass);
    expect(await cards.passPrice()).to.equal(pass);
    const bought = cards.connect(other).buyPass(1, { value: pass });
    await expect(bought).to.emit(cards, "PassBought").withArgs(1, other.address, pass);
    await expect(bought).to.changeEtherBalances([other, treasury], [-pass, pass]);
    await expect(cards.connect(agent).buyPass(1, { value: pass })).to.emit(cards, "PassBought").withArgs(1, agent.address, pass); // again: the server extends it
    await expect(cards.connect(other).buyPass(1, { value: pass / 2n })).to.be.revertedWithCustomError(cards, "WrongPrice");
    await expect(cards.connect(other).buyPass(1, { value: pass * 2n })).to.be.revertedWithCustomError(cards, "WrongPrice");
    await expect(cards.connect(other).buyPass(1, { value: 0 })).to.be.revertedWithCustomError(cards, "WrongPrice");
    await expect(cards.connect(other).buyPass(7, { value: pass })).to.be.revertedWithCustomError(cards, "ERC721NonexistentToken");
    expect(await ethers.provider.getBalance(await cards.getAddress())).to.equal(0n);
  });

  it("applies the owner's launch prices at once while no card exists, and a Mythic copy counts as a card", async () => {
    const { owner, other, cards } = await deploy();
    const [pack, pass, mythic] = [ethers.parseEther("0.004"), ethers.parseEther("0.02"), DESIGN.price * 2n];
    // the launch settings dev-fork.js (and the owner on mint day) signs right after deploy: no wait yet
    await cards.connect(owner).setFightPackPrice(pack);
    await cards.connect(owner).setPassPrice(pass);
    await cards.connect(owner).addMythics([{ ...DESIGN, open: false }]);
    await expect(cards.connect(owner).setMythicSale(1, mythic, true)).to.emit(cards, "MythicSaleSet").withArgs(1, mythic, true);
    expect([await cards.fightPackPrice(), await cards.passPrice(), (await cards.mythics(1)).price]).to.deep.equal([pack, pass, mythic]);
    // a Mythic copy is a card too, though totalSupply counts Agent ID cards only: from it on, prices wait
    await cards.connect(other).buyMythic(1, { value: mythic });
    expect([await cards.totalSupply(), await cards.totalCards()]).to.deep.equal([0n, 1n]);
    await expect(cards.connect(owner).setFightPackPrice(pack / 2n)).to.be.revertedWithCustomError(cards, "Timelocked");
    await expect(cards.connect(owner).setPassPrice(pass * 2n)).to.be.revertedWithCustomError(cards, "Timelocked");
    await expect(cards.connect(owner).setMythicSale(1, DESIGN.price, true)).to.be.revertedWithCustomError(cards, "Timelocked");
    // opening or closing a sale stays immediate: the same price, the sale closed
    await expect(cards.connect(owner).setMythicSale(1, mythic, false)).to.emit(cards, "MythicSaleSet").withArgs(1, mythic, false);
    await expect(cards.connect(other).buyMythic(1, { value: mythic })).to.be.revertedWithCustomError(cards, "SaleClosed");
  });

  it("holds every price change 48 hours once a card exists, a lower price or none too, and lets the owner cancel", async () => {
    const { owner, agent, other, signer, cards } = await deploy();
    const [pack, pass] = [ethers.parseEther("0.004"), ethers.parseEther("0.02")];
    await cards.connect(owner).setFightPackPrice(pack);
    await cards.connect(owner).setPassPrice(pass);
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    await expect(cards.connect(owner).setFightPackPrice(pack * 2n)).to.be.revertedWithCustomError(cards, "Timelocked");
    // a higher price is proposed in the open and applies 48 hours later, not a second sooner
    await expect(cards.connect(owner).propose(Setting.FightPackPrice, pack * 2n))
      .to.emit(cards, "SettingProposed").withArgs(Setting.FightPackPrice, 0, pack * 2n, anyValue);
    expect((await cards.pending(Setting.FightPackPrice, 0)).eta).to.equal(BigInt((await time.latest()) + TIMELOCK));
    await expect(cards.connect(owner).execute(Setting.FightPackPrice)).to.be.revertedWithCustomError(cards, "NotReady");
    await time.increase(TIMELOCK - 60);
    await expect(cards.connect(owner).execute(Setting.FightPackPrice)).to.be.revertedWithCustomError(cards, "NotReady");
    await expect(cards.connect(other).buyFights(1, 1, { value: pack })).to.emit(cards, "FightsBought"); // the old price holds meanwhile
    await time.increase(60);
    await expect(cards.connect(owner).execute(Setting.FightPackPrice))
      .to.emit(cards, "SettingChanged").withArgs(Setting.FightPackPrice, 0, pack * 2n);
    expect(await cards.fightPackPrice()).to.equal(pack * 2n);
    // a lower price waits just the same, and a cancelled one never applies
    await cards.connect(owner).propose(Setting.PassPrice, pass / 2n);
    await expect(cards.connect(owner).execute(Setting.PassPrice)).to.be.revertedWithCustomError(cards, "NotReady");
    await expect(cards.connect(owner).cancel(Setting.PassPrice)).to.emit(cards, "SettingCancelled").withArgs(Setting.PassPrice, 0);
    await time.increase(TIMELOCK);
    await expect(cards.connect(owner).execute(Setting.PassPrice)).to.be.revertedWithCustomError(cards, "NotReady");
    expect(await cards.passPrice()).to.equal(pass);
    // so does taking fight packs off sale (price 0)
    await setLater(cards, owner, Setting.FightPackPrice, 0);
    await expect(cards.connect(other).buyFights(1, 1, { value: 0 })).to.be.revertedWithCustomError(cards, "WrongPrice");
  });

  it("proposes a Mythic design's price with its design, shows it in allPending and applies it 48 hours later", async () => {
    const { owner, agent, other, signer, cards } = await deploy();
    await cards.connect(owner).addMythics([DESIGN, { ...DESIGN, name: "Dawnforged Seraph", region: 0, role: 1 }]);
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    const next = ethers.parseEther("0.08");
    await expect(cards.connect(owner).setMythicSale(2, next, true)).to.be.revertedWithCustomError(cards, "Timelocked");
    await expect(cards.connect(owner).propose(Setting.MythicPrice, next)).to.be.revertedWithCustomError(cards, "BadSetting"); // it needs the design
    await expect(cards.connect(owner).proposeMythicPrice(3, next)).to.be.revertedWithCustomError(cards, "NoSuchDesign");
    await expect(cards.connect(owner).proposeMythicPrice(2, next)).to.emit(cards, "SettingProposed").withArgs(Setting.MythicPrice, 2, next, anyValue);
    await cards.connect(owner).propose(Setting.PassPrice, 7);
    // watchers see every pending change in one call, a design's price under its design
    const [settings, mythicPrices] = await cards.allPending();
    expect(settings.map((p) => p.value)).to.deep.equal([0n, 0n, 0n, 0n, 0n, 0n, 0n, 7n]);
    expect(mythicPrices.map((p) => p.value)).to.deep.equal([0n, next]);
    expect(mythicPrices[1].eta).to.equal((await cards.pending(Setting.MythicPrice, 2)).eta);
    // the old price holds for the 48 hours
    await expect(cards.connect(owner).executeMythicPrice(2)).to.be.revertedWithCustomError(cards, "NotReady");
    await expect(cards.connect(other).buyMythic(2, { value: DESIGN.price })).to.emit(cards, "MythicMinted");
    await time.increase(TIMELOCK);
    await expect(cards.connect(owner).executeMythicPrice(1)).to.be.revertedWithCustomError(cards, "NotReady"); // nothing pending for it
    await expect(cards.connect(owner).executeMythicPrice(2)).to.emit(cards, "SettingChanged").withArgs(Setting.MythicPrice, 2, next);
    const m = await cards.mythics(2);
    expect([m.price, m.open]).to.deep.equal([next, true]); // the sale stays as it was
    await expect(cards.connect(other).buyMythic(2, { value: DESIGN.price })).to.be.revertedWithCustomError(cards, "WrongPrice");
    await expect(cards.connect(other).buyMythic(2, { value: next })).to.emit(cards, "MythicMinted");
    expect((await cards.allPending())[1][1].eta).to.equal(0n);
    // a cancelled design price never applies
    await cards.connect(owner).proposeMythicPrice(1, 1);
    await expect(cards.connect(owner).cancelMythicPrice(1)).to.emit(cards, "SettingCancelled").withArgs(Setting.MythicPrice, 1);
    await time.increase(TIMELOCK);
    await expect(cards.connect(owner).executeMythicPrice(1)).to.be.revertedWithCustomError(cards, "NotReady");
    expect((await cards.mythics(1)).price).to.equal(DESIGN.price);
  });

  it("sells a listed card on the built-in market: the seller is paid, the fee and royalty go to the treasury", async () => {
    const { agent, other, treasury, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    const price = ethers.parseEther("1");
    await expect(cards.connect(other).list(1, price)).to.be.revertedWithCustomError(cards, "NotCardOwner");
    await expect(cards.connect(other).buy(1, { value: price })).to.be.revertedWithCustomError(cards, "WrongPrice"); // not listed
    await expect(cards.connect(agent).list(1, price)).to.emit(cards, "Listed").withArgs(1, agent.address, price);
    await expect(cards.connect(agent).buy(1, { value: price })).to.be.revertedWithCustomError(cards, "OwnCard");
    await expect(cards.connect(other).buy(1, { value: price / 2n })).to.be.revertedWithCustomError(cards, "WrongPrice");
    const take = ethers.parseEther("0.075"); // 2.5% fee + 5% royalty
    const sale = cards.connect(other).buy(1, { value: price });
    await expect(sale).to.emit(cards, "Sold").withArgs(1, agent.address, other.address, price);
    await expect(sale).to.changeEtherBalances([other, agent, treasury], [-price, price - take, take]);
    expect(await cards.ownerOf(1)).to.equal(other.address);
    expect(await cards.priceOf(1)).to.equal(0n);
    expect(await ethers.provider.getBalance(await cards.getAddress())).to.equal(0n);
  });

  it("takes a card off the market when it moves, and caps the market fee at 10%", async () => {
    const { owner, agent, other, treasury, signer, cards } = await deploy();
    const [s, sig] = await stats(cards, signer, agent.address);
    await cards.connect(agent).mint(s, sig);
    const price = ethers.parseEther("1");
    await cards.connect(agent).list(1, price);
    await cards.connect(agent).transferFrom(agent.address, other.address, 1); // sold elsewhere, or a gift
    expect(await cards.priceOf(1)).to.equal(0n);
    await expect(cards.connect(agent).buy(1, { value: price })).to.be.revertedWithCustomError(cards, "WrongPrice");
    await cards.connect(other).list(1, price);
    await cards.connect(other).list(1, 0); // 0 takes it off
    expect(await cards.priceOf(1)).to.equal(0n);
    await expect(cards.connect(owner).propose(Setting.MarketFee, 1001)).to.be.revertedWithCustomError(cards, "FeeTooHigh");
    await expect(cards.connect(other).propose(Setting.MarketFee, 0)).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    await setLater(cards, owner, Setting.MarketFee, 0); // a fee change waits 48 hours, so sellers see it coming
    await cards.connect(other).list(1, price);
    await expect(cards.connect(agent).buy(1, { value: price })).to.changeEtherBalances([other, treasury], [price - price / 20n, price / 20n]);
  });

  it("stays within the contract size limit and reports gas", async () => {
    const { agent, signer, cards } = await deploy();
    for (const name of ["AgentCards", "CardRenderer"]) {
      const art = await artifacts.readArtifact(name);
      const size = (art.deployedBytecode.length - 2) / 2;
      console.log(`      ${name}: ${size} bytes`);
      expect(size).to.be.below(24576);
    }
    const [s, sig] = await stats(cards, signer, agent.address);
    const rc = await (await cards.connect(agent).mint(s, sig)).wait();
    const [u, uSig] = await update(cards, signer, 1, { level: 9 });
    const urc = await (await cards.connect(agent).update(u, uSig)).wait();
    console.log(`      mint gas: ${rc.gasUsed}, update gas: ${urc.gasUsed}`);
  });
});
