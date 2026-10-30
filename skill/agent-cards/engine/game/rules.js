// The numbers behind the Clash duel. Change them here, then run `node scripts/sim-clash.mjs` and keep its targets.
// Plain data with no imports, so the engine, the skill table and the rule texts can all read it.

export const ACTIONS = ["strike", "guard", "break", "charge", "skill"];

export const TUNING = {
  hp: 100, // a plain card's HP
  strike: 12, // a plain Strike's damage
  vulnerable: 1.25, // a Strike or Skill into a Charge, and a Strike into a Break, hit this much harder
  breakGuard: 1.3, // Break into Guard: damage, and the guard loses 1 Focus
  breakCharge: 1.0, // Break into Charge: damage, and the Charge gains nothing
  counter: 0.5, // Guard against Strike: the guard hits back for this much
  skill: 3.0, // Skill damage; it trades through a Strike
  chip: 0.3, // Skill into Guard: the little that gets through
  skillCost: 3,
  focusStart: 1,
  focusCap: 5,
  focusStrike: 1, // for a Strike that lands
  focusGuard: 1, // for a Guard that stops a Strike or a Skill
  focusCharge: 2,
  focusBroken: 1, // lost when your Guard is broken
  healDecay: 0.75, // each heal from Charging is worth 75% of the one before
  suddenDeath: 10, // from this round on: +25% damage every round and no healing
  suddenDeathStep: 0.25,
  maxRounds: 16, // then the higher HP share wins, then the damage dealt, else a draw
  variance: 0.05, // damage rolls 95%..105%
  critChance: 0.05,
  critMult: 1.5,
  roleEdge: 0.06, // extra damage against the role yours counters
  stat: 0.004, // per point above or below 50: Power scales damage, Defense scales HP
  luckCrit: 0.001, // crit chance per point of Luck above or below 50
  // how much level and rarity count: duels (the ladder, challenges, live) keep them small so decisions decide
  scaling: {
    ranked: { level: 0.016, rarity: 0.033 },
    full: { level: 0.05, rarity: 0.08 }, // dungeons and bosses (Season 2)
  },
};

// index = the on-chain role number. The cycle: Warrior > Assassin > Mage > Priest > Warrior.
export const ROLES = {
  1: { name: "Warrior", hp: 1.15, dmg: 0.95, counter: 0.55, chipTaken: 0, beats: 4 },
  2: { name: "Priest", hp: 1.15, dmg: 0.9, chargeHeal: 0.12, guardHeal: 0.05, regen: 0.028, beats: 1 },
  3: { name: "Mage", hp: 0.95, dmg: 1.22, focusCap: 6, focusCharge: 3, skill: 3.6, beats: 2 },
  4: { name: "Assassin", hp: 0.9, dmg: 1.2, critChance: 0.2, critMult: 2.0, firstStrike: true, beats: 3 },
};
