// Mythic cards: limited, numbered series sold at a fixed price, plus a wheel reserve claimed with server vouchers.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PRICE = ethers.parseEther("0.05");
const TIMELOCK = 48 * 3600;
const IMG = "https://cards.test/api/card/";
const SITE = "https://cards.test/card/";
const BASE = 1_000_000n; // AgentCards.MYTHIC_BASE
const mythicId = (design, number) => BASE + BigInt(design) * 1000n + BigInt(number);

// Season 1's first design, as worker/src/mythic.js describes it
const SAINT = {
  name: "Plum Blossom Saint", region: 1, role: 4, season: 1, open: false,
  power: 46, defense: 46, speed: 73, luck: 61,
  saleSupply: 45, sold: 0, wheelReserve: 5, awarded: 0, price: PRICE,
};

const LINKS = { imageBase: IMG, imageSuffix: ".svg", siteBase: SITE, animationBase: "", animationSuffix: "" };

// `signer` signs mints and level updates; `vSigner` signs only wheel vouchers
async function deploy() {
  const [owner, buyer, other, treasury, operator] = await ethers.getSigners();
  const signer = ethers.Wallet.createRandom();
  const vSigner = ethers.Wallet.createRandom();
  const registry = await ethers.deployContract("MockRegistry");
  const renderer = await ethers.deployContract("CardRenderer", [owner.address, LINKS]);
  const cards = await ethers.deployContract("AgentCards", [
    owner.address, operator.address, treasury.address, signer.address, vSigner.address,
    await registry.getAddress(), await renderer.getAddress(),
  ]);
  return { owner, operator, buyer, other, treasury, signer, vSigner, registry, renderer, cards };
}

async function withSaint(over = {}) {
  const d = await deploy();
  await d.cards.connect(d.owner).addMythic({ ...SAINT, ...over });
  return d;
}

async function domain(cards) {
  const { chainId } = await ethers.provider.getNetwork();
  return { name: "AgentCards", version: "1", chainId, verifyingContract: await cards.getAddress() };
}

const CLAIM_TYPES = {
  MythicClaim: [
    { name: "to", type: "address" }, { name: "design", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint64" },
  ],
};

async function voucher(cards, signer, to, over = {}) {
  const v = { to, design: 1, nonce: 7n, expiry: (await time.latest()) + 600, ...over };
  return [v, await signer.signTypedData(await domain(cards), CLAIM_TYPES, v)];
}

function decode(uri) {
  const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
  const trait = (t) => json.attributes.filter((a) => a.trait_type === t).map((a) => a.value);
  return { json, trait };
}

describe("Mythic cards", () => {
  it("lets only the owner add a design, and checks it", async () => {
    const { owner, other, cards } = await deploy();
    await expect(cards.connect(other).addMythic(SAINT)).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    await expect(cards.connect(owner).addMythic({ ...SAINT, name: 'Saint"' })).to.be.revertedWithCustomError(cards, "BadName");
    await expect(cards.connect(owner).addMythic({ ...SAINT, name: "" })).to.be.revertedWithCustomError(cards, "BadName");
    await expect(cards.connect(owner).addMythic({ ...SAINT, role: 5 })).to.be.revertedWithCustomError(cards, "BadStats");
    await expect(cards.connect(owner).addMythic({ ...SAINT, luck: 100 })).to.be.revertedWithCustomError(cards, "BadStats");
    // no design can total more than a minted card can reach (226): a stolen owner key can't sell super cards
    await expect(cards.connect(owner).addMythic({ ...SAINT, luck: 62 })).to.be.revertedWithCustomError(cards, "BadStats");
    await expect(cards.connect(owner).addMythic({ ...SAINT, power: 99, defense: 99, speed: 99, luck: 99 })).to.be.revertedWithCustomError(cards, "BadStats");
    await expect(cards.connect(owner).addMythic({ ...SAINT, saleSupply: 0, wheelReserve: 0 })).to.be.revertedWithCustomError(cards, "BadSupply");
    await expect(cards.connect(owner).addMythic({ ...SAINT, saleSupply: 995 })).to.be.revertedWithCustomError(cards, "BadSupply");
    await expect(cards.connect(owner).addMythic({ ...SAINT, sold: 3 })).to.be.revertedWithCustomError(cards, "BadSupply");
    await expect(cards.connect(owner).addMythic(SAINT)).to.emit(cards, "MythicAdded").withArgs(1, "Plum Blossom Saint", 50, PRICE);
    expect(await cards.mythicDesigns()).to.equal(1n);
    const m = await cards.mythics(1);
    expect([m.name, m.region, m.role, m.saleSupply, m.wheelReserve, m.open]).to.deep.equal(["Plum Blossom Saint", 1n, 4n, 45n, 5n, false]);
  });

  it("sells numbered copies at the fixed price, straight to the treasury, only while the sale is open", async () => {
    const { owner, buyer, other, treasury, cards } = await withSaint();
    await expect(cards.connect(buyer).buyMythic(1, { value: PRICE })).to.be.revertedWithCustomError(cards, "SaleClosed");
    await expect(cards.connect(other).setMythicSale(1, PRICE, true)).to.be.revertedWithCustomError(cards, "OwnableUnauthorizedAccount");
    await expect(cards.connect(owner).setMythicSale(1, PRICE, true)).to.emit(cards, "MythicSaleSet").withArgs(1, PRICE, true);
    await expect(cards.connect(buyer).buyMythic(2, { value: PRICE })).to.be.revertedWithCustomError(cards, "NoSuchDesign");
    await expect(cards.connect(buyer).buyMythic(1, { value: PRICE - 1n })).to.be.revertedWithCustomError(cards, "WrongPrice");
    await expect(cards.connect(buyer).buyMythic(1, { value: PRICE })).to.changeEtherBalances([buyer, treasury], [-PRICE, PRICE]);
    expect(await ethers.provider.getBalance(await cards.getAddress())).to.equal(0n);

    const id = mythicId(1, 1);
    expect(await cards.ownerOf(id)).to.equal(buyer.address);
    const c = await cards.card(id);
    expect([c.name, c.agent, c.rarity, c.region, c.role, c.awakened, c.level]).to.deep.equal(["Plum Blossom Saint", buyer.address, 4n, 1n, 4n, false, 1n]);
    expect([c.power, c.defense, c.speed, c.luck]).to.deep.equal([46n, 46n, 73n, 61n]);
    expect(await cards.editionOf(id)).to.deep.equal([1n, 1n, 1n, 50n]);
    await expect(cards.connect(other).buyMythic(1, { value: PRICE })).to.emit(cards, "MythicMinted").withArgs(mythicId(1, 2), 1, other.address, 2, false);
    expect(await cards.totalSupply()).to.equal(0n); // Agent ID card numbers are untouched

    // copies are out now, so a new price (0 = not for sale) is proposed and waits 48 hours
    await expect(cards.connect(owner).setMythicSale(1, 0, true)).to.be.revertedWithCustomError(cards, "Timelocked");
    await cards.connect(owner).proposeMythicPrice(1, 0);
    await time.increase(TIMELOCK);
    await cards.connect(owner).executeMythicPrice(1);
    await expect(cards.connect(buyer).buyMythic(1, { value: 0 })).to.be.revertedWithCustomError(cards, "WrongPrice");
    await expect(cards.connect(buyer).buyMythic(1, { value: PRICE })).to.be.revertedWithCustomError(cards, "WrongPrice");
  });

  it("stops each series at its sale supply and its wheel reserve, separately", async () => {
    const { owner, buyer, other, vSigner, cards } = await withSaint({ saleSupply: 2, wheelReserve: 1, open: true });
    await cards.connect(buyer).buyMythic(1, { value: PRICE });
    await cards.connect(buyer).buyMythic(1, { value: PRICE });
    await expect(cards.connect(buyer).buyMythic(1, { value: PRICE })).to.be.revertedWithCustomError(cards, "SoldOut");
    const [v, sig] = await voucher(cards, vSigner, other.address, { nonce: 1n });
    await expect(cards.connect(other).claimMythic(v, sig)).to.emit(cards, "MythicMinted").withArgs(mythicId(1, 3), 1, other.address, 3, true);
    expect(await cards.totalCards()).to.equal(3n); // totalSupply stays 0: it counts Agent ID cards only
    const [v2, sig2] = await voucher(cards, vSigner, other.address, { nonce: 2n });
    await expect(cards.connect(other).claimMythic(v2, sig2)).to.be.revertedWithCustomError(cards, "SoldOut");
    expect(await cards.editionOf(mythicId(1, 3))).to.deep.equal([1n, 1n, 3n, 3n]);
    await expect(cards.connect(owner).setMythicSale(1, PRICE, false)).to.not.be.reverted;
  });

  it("mints wheel copies only for a fresh, unused voucher from the voucher signer, to the winner it names", async () => {
    const { buyer, other, signer, vSigner, cards } = await withSaint(); // not on sale: the reserve doesn't need it
    const [v, sig] = await voucher(cards, vSigner, buyer.address);
    const forger = ethers.Wallet.createRandom();
    const [, forged] = await voucher(cards, forger, buyer.address);
    await expect(cards.connect(buyer).claimMythic(v, forged)).to.be.revertedWithCustomError(cards, "BadSignature");
    // the mint/level signer can't sign vouchers: one leaked key can't do both jobs
    const [, mintKeySig] = await voucher(cards, signer, buyer.address);
    await expect(cards.connect(buyer).claimMythic(v, mintKeySig)).to.be.revertedWithCustomError(cards, "BadSignature");
    await expect(cards.connect(buyer).claimMythic({ ...v, to: other.address }, sig)).to.be.revertedWithCustomError(cards, "BadSignature");
    const [old, oldSig] = await voucher(cards, vSigner, buyer.address, { expiry: (await time.latest()) - 1 });
    await expect(cards.connect(buyer).claimMythic(old, oldSig)).to.be.revertedWithCustomError(cards, "Expired");
    const [none, noneSig] = await voucher(cards, vSigner, buyer.address, { design: 9, nonce: 8n });
    await expect(cards.connect(buyer).claimMythic(none, noneSig)).to.be.revertedWithCustomError(cards, "NoSuchDesign");

    await cards.connect(other).claimMythic(v, sig); // anyone may submit it; the card goes to the winner
    expect(await cards.ownerOf(mythicId(1, 1))).to.equal(buyer.address);
    expect(await cards.claimUsed(v.nonce)).to.equal(true);
    await expect(cards.connect(buyer).claimMythic(v, sig)).to.be.revertedWithCustomError(cards, "ClaimUsed");
    const m = await cards.mythics(1);
    expect([m.sold, m.awarded]).to.deep.equal([0n, 1n]);
  });

  it("describes Mythic cards with their own name, series and edition, and an animation once it is set", async () => {
    const { owner, buyer, other, signer, registry, renderer, cards } = await withSaint({ open: true });
    await cards.connect(buyer).buyMythic(1, { value: PRICE });
    const id = mythicId(1, 1);
    let { json, trait } = decode(await cards.tokenURI(id));
    expect(json.name).to.equal("Plum Blossom Saint #1/50");
    expect(json.description).to.match(/^Agent Cards Mythic/);
    expect(json.image).to.equal(`${IMG}${id}.svg?v=${(await cards.card(id)).updatedAt}`);
    expect(json.external_url).to.equal(`${SITE}${id}`);
    expect(json.animation_url).to.equal(undefined);
    expect(trait("Rarity")).to.deep.equal(["Mythic"]);
    expect(trait("Class")).to.deep.equal(["Plum Blossom Saint"]);
    expect(trait("Region")).to.deep.equal(["East"]);
    expect(trait("Role")).to.deep.equal(["Assassin"]);
    expect(trait("Series")).to.deep.equal(["Season 1"]);
    expect(trait("Edition")).to.deep.equal(["1 of 50"]);

    const live = { ...LINKS, animationBase: SITE, animationSuffix: "/live" };
    await expect(renderer.connect(other).proposeLinks(live)).to.be.revertedWithCustomError(renderer, "OwnableUnauthorizedAccount");
    await renderer.connect(owner).proposeLinks(live);
    await time.increase(48 * 3600);
    await renderer.connect(owner).executeLinks();
    ({ json } = decode(await cards.tokenURI(id)));
    expect(json.animation_url).to.equal(`${SITE}${id}/live`);

    // an Agent ID card keeps its usual metadata, without an animation or Mythic traits
    await registry.register(other.address, "nova");
    const now = await time.latest();
    const s = { wallet: other.address, label: "nova", power: 40, defense: 55, speed: 70, luck: 30, role: 4, region: 1, badges: 0, roll: 5_000, issuedAt: now, expiry: now + 600 };
    const types = {
      Stats: [
        { name: "wallet", type: "address" }, { name: "label", type: "string" },
        { name: "power", type: "uint8" }, { name: "defense", type: "uint8" }, { name: "speed", type: "uint8" },
        { name: "luck", type: "uint8" }, { name: "role", type: "uint8" }, { name: "region", type: "uint8" },
        { name: "badges", type: "uint32" }, { name: "roll", type: "uint32" },
        { name: "issuedAt", type: "uint64" }, { name: "expiry", type: "uint64" },
      ],
    };
    await cards.connect(other).mint(s, await signer.signTypedData(await domain(cards), types, s));
    ({ json, trait } = decode(await cards.tokenURI(1)));
    expect(json.name).to.equal("nova.ai #1");
    expect(json.animation_url).to.equal(undefined);
    expect(trait("Class")).to.deep.equal(["Plum Blossom Swordsman"]);
    expect(trait("Series")).to.deep.equal(["Genesis"]); // an Agent ID card's series, not a Mythic season
    expect(await cards.editionOf(1)).to.deep.equal([0n, 0n, 0n, 0n]);
  });

  it("plays like any card: holo, level updates and the built-in market", async () => {
    const { owner, operator, buyer, other, treasury, signer, cards } = await withSaint({ open: true });
    await cards.connect(buyer).buyMythic(1, { value: PRICE });
    const id = mythicId(1, 1);
    await expect(cards.connect(operator).grantHolo([id])).to.emit(cards, "HoloApplied").withArgs(id, operator.address); // earned, never sold
    expect((await cards.card(id)).holo).to.equal(true);
    const now = await time.latest();
    const u = { id, level: 5, badges: 0, issuedAt: now + 1, expiry: now + 600 };
    const types = {
      Update: [
        { name: "id", type: "uint256" }, { name: "level", type: "uint16" }, { name: "badges", type: "uint32" },
        { name: "issuedAt", type: "uint64" }, { name: "expiry", type: "uint64" },
      ],
    };
    await cards.connect(buyer).update(u, await signer.signTypedData(await domain(cards), types, u));
    expect((await cards.card(id)).level).to.equal(5n);

    const price = ethers.parseEther("0.2");
    await cards.connect(buyer).list(id, price);
    const cut = (price * 750n) / 10_000n; // 2.5% fee + 5% royalty
    await expect(cards.connect(other).buy(id, { value: price })).to.changeEtherBalances([other, buyer, treasury], [-price, price - cut, cut]);
    expect(await cards.ownerOf(id)).to.equal(other.address);
    await expect(cards.connect(owner).grantHolo([id])).to.not.be.reverted; // already holo: skipped
  });

  it("only ever shrinks a series, never below the copies already out", async () => {
    const { owner, buyer, other, cards } = await withSaint({ open: true });
    await cards.connect(buyer).buyMythic(1, { value: PRICE });
    await cards.connect(buyer).buyMythic(1, { value: PRICE });
    await expect(cards.connect(other).capMythic(1, 10, 1)).to.be.revertedWithCustomError(cards, "NotOperator");
    await expect(cards.connect(owner).capMythic(1, 46, 5)).to.be.revertedWithCustomError(cards, "BadSupply");
    await expect(cards.connect(owner).capMythic(1, 45, 6)).to.be.revertedWithCustomError(cards, "BadSupply");
    await expect(cards.connect(owner).capMythic(1, 1, 5)).to.be.revertedWithCustomError(cards, "BadSupply");
    await expect(cards.connect(owner).capMythic(1, 2, 0)).to.emit(cards, "MythicCapped").withArgs(1, 2, 0);
    await expect(cards.connect(buyer).buyMythic(1, { value: PRICE })).to.be.revertedWithCustomError(cards, "SoldOut");
    expect(await cards.editionOf(mythicId(1, 2))).to.deep.equal([1n, 1n, 2n, 2n]);
  });

  it("grants frames for wheel prizes without replacing a frame a card already wears", async () => {
    const { owner, buyer, other, cards } = await withSaint({ open: true });
    await cards.connect(buyer).buyMythic(1, { value: PRICE });
    await cards.connect(buyer).buyMythic(1, { value: PRICE });
    const [a, b] = [mythicId(1, 1), mythicId(1, 2)];
    await expect(cards.connect(other).grantFrame([a], 1)).to.be.revertedWithCustomError(cards, "NotOperator");
    await expect(cards.connect(owner).grantFrame([a], 0)).to.be.revertedWithCustomError(cards, "BadFrame");
    await expect(cards.connect(owner).grantFrame([a], 2)).to.emit(cards, "FrameApplied").withArgs(a, 2);
    await cards.connect(owner).grantFrame([a, b], 3);
    expect((await cards.card(a)).frame).to.equal(2n); // kept
    expect((await cards.card(b)).frame).to.equal(3n);
    await expect(cards.connect(owner).grantFrame([mythicId(1, 9)], 1)).to.be.revertedWithCustomError(cards, "ERC721NonexistentToken");
  });

  it("keeps Agent ID card numbers below the Mythic ids", async () => {
    const { other, signer, registry, cards } = await deploy();
    const addr = await cards.getAddress();
    const slots = async () => Promise.all(Array.from({ length: 40 }, (_, i) => ethers.provider.getStorage(addr, i)));
    const mintAs = async (label) => {
      await registry.register(other.address, label);
      const now = await time.latest();
      const s = { wallet: other.address, label, power: 40, defense: 55, speed: 70, luck: 30, role: 1, region: 0, badges: 0, roll: 5_000, issuedAt: now, expiry: now + 600 };
      const types = {
        Stats: [
          { name: "wallet", type: "address" }, { name: "label", type: "string" },
          { name: "power", type: "uint8" }, { name: "defense", type: "uint8" }, { name: "speed", type: "uint8" },
          { name: "luck", type: "uint8" }, { name: "role", type: "uint8" }, { name: "region", type: "uint8" },
          { name: "badges", type: "uint32" }, { name: "roll", type: "uint32" },
          { name: "issuedAt", type: "uint64" }, { name: "expiry", type: "uint64" },
        ],
      };
      return cards.connect(other).mint(s, await signer.signTypedData(await domain(cards), types, s));
    };
    const before = await slots();
    await mintAs("first");
    const after = await slots();
    const slot = after.findIndex((v, i) => v !== before[i]); // the only plain slot a mint writes: totalSupply
    expect(BigInt(after[slot])).to.equal(1n);
    await network.provider.send("hardhat_setStorageAt", [addr, ethers.toQuantity(slot), ethers.zeroPadValue(ethers.toBeHex(BASE - 1n), 32)]);
    await expect(mintAs("second")).to.be.revertedWithCustomError(cards, "SoldOut");
  });

  it("reports Mythic gas", async () => {
    const { buyer, other, vSigner, cards } = await withSaint({ open: true });
    const buy = await (await cards.connect(buyer).buyMythic(1, { value: PRICE })).wait();
    const [v, sig] = await voucher(cards, vSigner, other.address);
    const claim = await (await cards.connect(other).claimMythic(v, sig)).wait();
    console.log(`      buyMythic gas: ${buy.gasUsed}, claimMythic gas: ${claim.gasUsed}`);
  });
});
