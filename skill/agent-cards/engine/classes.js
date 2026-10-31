// Regions and the class each role becomes in them. Mirrors CardRenderer.className on chain; the slug names
// the class's illustrations (art/<slug>-<rarity>[-n].png). What each signature skill does in the Clash duel,
// and its text, live in game/skills.js.
import { skillText } from "./game/skills.js";

export const REGIONS = ["West", "East", "North", "South"]; // index = on-chain region number

const CLASSES = {
  // region: [Warrior, Priest, Mage, Assassin]
  0: [
    { slug: "paladin", name: "Paladin", skill: "Holy Bulwark" },
    { slug: "templar", name: "Templar", skill: "Mending Light" },
    { slug: "archmage", name: "Archmage", skill: "Arcane Surge" },
    { slug: "shadow-blade", name: "Shadow Blade", skill: "Backstab" },
  ],
  1: [
    { slug: "iron-monk", name: "Iron Mountain Monk", skill: "Iron Body" },
    { slug: "wandering-daoist", name: "Wandering Daoist", skill: "Incense of Calm" },
    { slug: "talisman-sage", name: "Talisman Sage", skill: "Five Seals" },
    { slug: "plum-blossom", name: "Plum Blossom Swordsman", skill: "Twenty-Four Blossoms" },
  ],
  2: [
    { slug: "berserker", name: "Berserker", skill: "Blood Rage" },
    { slug: "rune-priestess", name: "Rune Priestess", skill: "Rune Ward" },
    { slug: "frost-witch", name: "Frost Witch", skill: "Winter's Grasp" },
    { slug: "wolf-hunter", name: "Wolf Hunter", skill: "Pack Hunt" },
  ],
  3: [
    { slug: "sun-guardian", name: "Sun Guardian", skill: "Solar Aegis" },
    { slug: "oracle", name: "Oracle", skill: "Foresight" },
    { slug: "djinn-caller", name: "Djinn Caller", skill: "Sandstorm" },
    { slug: "sand-dancer", name: "Sand Dancer", skill: "Mirage Step" },
  ],
};

// awakened cards of these region/role pairs become hidden classes; other awakened cards wait for theirs
const HIDDEN = {
  "1-4": { slug: "blind-sword-master", name: "Blind Sword Master", skill: "Sightless Cut", hidden: true },
};

// Each class's four cards tell one story, a chapter per rarity (Common, Rare, Epic, Legendary): [title, line]. The
// art follows it (gorsel_promptlari_sade.md) and the class finder prints it under the cards. A hidden class only
// comes as Epic or Legendary, so its first two chapters are empty.
const STORIES = {
  paladin: [["The Oath", "A young knight takes his vows on a misty hill."], ["The Road", "He rides out to answer the call."], ["The Battle", "The field is won. The cost is not."], ["The Prayer", "He kneels before the saint and asks for peace."]],
  templar: [["The Novice", "A novice sweeps the cloister steps at dawn."], ["The Guide", "She leads pilgrims across the mountain pass."], ["The Gate", "She holds the gate alone through the storm."], ["The Staff", "Grown old, she hands her staff to a new novice."]],
  archmage: [["The Apprentice", "An apprentice crosses the moor toward the tower."], ["The Stars", "He learns to read the sky from the tower top."], ["The Fire", "His library burns. He saves a single book."], ["The Release", "Its last pages turn into white birds and fly."]],
  "shadow-blade": [["The Street", "A street thief runs the rooftops of the city."], ["The Bell Tower", "She watches the city from the bell tower."], ["The Job", "One job goes wrong."], ["The Dawn", "She leaves her daggers in a fence post and walks into the sunrise."]],
  "iron-monk": [["The Courtyard", "A young monk trains his staff form in the temple yard."], ["The Steps", "He carries water up the endless steps in the rain."], ["The Pass", "He holds the mountain pass alone."], ["The Peak", "On the peak he meditates; a bird lands on his staff."]],
  "wandering-daoist": [["The Road", "She sets out on the mountain path."], ["The Healer", "In a poor village she brews medicine for the sick."], ["The Empty Village", "She walks through a village emptied by war."], ["The Shrine", "At the shrine above the clouds she hangs up her hat."]],
  "talisman-sage": [["The Scribe", "A young scribe learns to draw talismans."], ["The Ward", "She paints a ward on the village gate."], ["The Storm", "She holds back a mountain storm."], ["The Last Seal", "She sets her last talisman on the lake and lets it go."]],
  "plum-blossom": [["The Disciple", "A young disciple walks the snowy plum road."], ["The Bridge", "On the bridge he meets his rival."], ["The Duel", "After the duel he stands alone among the petals."], ["The Grave", "Years later he pours wine on his rival's grave."]],
  berserker: [["The Shore", "A young warrior waits on the cold shore."], ["The Longship", "He sails out on the longship."], ["The Ice Field", "He is spent on a frozen battlefield."], ["The Barrow", "At his comrades' barrow he hangs his axe on the rune stone."]],
  "rune-priestess": [["The Stones", "A young priestess walks among the standing stones."], ["The Casting", "In the longhouse she casts the runes."], ["The Omen", "The fate she saw comes true."], ["The New Stone", "She carves a new stone for the lost."]],
  "frost-witch": [["The Hut", "An apprentice learns in a snowed-in hut."], ["The Frozen Lake", "She crosses the frozen lake alone."], ["The Blizzard", "She holds the blizzard back from the village."], ["The Thaw", "As spring comes, the crystal in her hand melts."]],
  "wolf-hunter": [["The Trail", "A young hunter sets out with his wolf."], ["The Hunt", "Together they track a great beast."], ["The Pack", "After the pack, he kneels by his wounded wolf."], ["The Grave", "Grown old, he sits by his old wolf's grave with a new pup."]],
  "sun-guardian": [["The Recruit", "A young guardian joins the temple guard."], ["The Watch", "He keeps the night watch on the wall."], ["The Sandstorm", "He holds the gate through the sandstorm."], ["The Altar", "He leaves his cracked shield at the sun altar."]],
  oracle: [["The Lamps", "A young woman tends the temple lamps."], ["The Bowl", "She reads the stars in a bowl of water."], ["The Storm", "The sandstorm she foresaw arrives."], ["The Offering", "At the oasis she sets a reed boat afloat with a flower."]],
  "djinn-caller": [["The Lamp", "A young mage sells his lamp in the bazaar."], ["The Summoning", "On a dune he calls his first djinn."], ["The Bargain", "The bargain turns against him in the storm."], ["The Release", "At sunrise he sets the djinn free."]],
  "sand-dancer": [["The Canyon", "A young dancer practises in the canyon."], ["The Fire", "She dances by the caravan fire."], ["The Ruins", "She survives a fight among broken columns."], ["The Last Dance", "At sunset she dances alone for the fallen."]],
  "blind-sword-master": [null, null, ["The Rain", "Blindfolded, he waits in the rain, ready to draw."], ["The Lesson", "Grown old, he teaches a child to hold a wooden sword."]],
};

/** A class's story, one chapter per rarity: [{ title, line } | null] x4. */
export const storyOf = (slug) => (STORIES[slug] || [null, null, null, null]).map((s) => (s ? { title: s[0], line: s[1] } : null));

const withText = (c) => ({ ...c, text: skillText(c.slug) });

/** Regions open for minting; the contract's openRegions mask must agree. */
export const DEFAULT_OPEN_REGIONS = "west,east,north,south";

export function classOf(region, role, awakened = false) {
  if (awakened && HIDDEN[`${region}-${role}`]) return withText(HIDDEN[`${region}-${role}`]);
  const c = CLASSES[region]?.[role - 1];
  return c ? withText(c) : { slug: `${(REGIONS[region] || "region").toLowerCase()}-${role}`, name: `${REGIONS[region] || "Region"} ${role}`, skill: "", text: "" };
}

/** Every class with art, for the art build and the site: [{ slug, name, skill, text, rarities }]. */
export function allClasses() {
  const list = Object.values(CLASSES).flat().map((c) => ({ ...withText(c), rarities: [0, 1, 2, 3] }));
  return list.concat(Object.values(HIDDEN).map((c) => ({ ...withText(c), rarities: [2, 3] })));
}

/** "east" / "East" / "1" -> 1; null when unknown or closed. */
export function parseRegion(input, open = DEFAULT_OPEN_REGIONS) {
  const v = String(input ?? "").trim().toLowerCase();
  const i = /^\d$/.test(v) ? Number(v) : REGIONS.findIndex((r) => r.toLowerCase() === v);
  const isOpen = String(open).toLowerCase().split(",").map((s) => s.trim()).includes((REGIONS[i] || "").toLowerCase());
  return i >= 0 && isOpen ? i : null;
}
