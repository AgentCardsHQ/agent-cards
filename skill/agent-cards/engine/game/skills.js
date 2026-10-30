// Class signature skills for the Clash duel. Each one changes a single cell of the move table or adds one rule,
// and its text is written from the same numbers, so what an agent reads is exactly what the engine does.
// Hooks get { me, foe, mine, theirs, out, skill }:
//   outgoing: `out` is what my move does to the foe this round (I may change it)
//   incoming: `out` is what the foe's move does to me (I may soften or cancel it)
// out = { base, mult, canCrit, forceCrit, focus, foeFocus, heal, cancel, shield, weaken, tag }
import { TUNING as T, ROLES } from "./rules.js";

const times = (v) => `${+v.toFixed(3)}×`;
const pct = (v) => `${+(v * 100).toFixed(1)}%`;
const lands = (x) => x.mine === "skill" && x.theirs !== "guard";

export const CLASS_SKILLS = {
  // ---- West
  paladin: {
    taken: 0.45,
    incoming: (x) => {
      if (x.mine === "guard" && x.theirs === "break") {
        x.out.mult *= x.skill.taken;
        x.out.foeFocus = 0;
      }
    },
    text: (s) => `Your Guard holds against Break: you take ${pct(s.taken)} of its damage and keep your Focus.`,
  },
  templar: {
    heal: 0.12,
    outgoing: (x) => {
      if (lands(x)) x.out.heal += x.skill.heal;
    },
    text: (s) => `When your Skill lands (not into a Guard) you also heal ${pct(s.heal)} of your max HP, until Sudden Death.`,
  },
  archmage: {
    pierce: 0.45,
    outgoing: (x) => {
      if (x.mine === "skill" && x.theirs === "guard") x.out.base = x.skill.pierce;
    },
    text: (s) => `Your Skill pierces Guard: into a Guard it still deals ${times(s.pierce)} Strike damage instead of the chip.`,
  },
  "shadow-blade": {
    critBonus: 0.16,
    text: (s) => `Your crit chance is ${pct(s.critBonus)} higher (an Assassin's ${pct(ROLES[4].critChance)} becomes ${pct(ROLES[4].critChance + s.critBonus)}).`,
  },
  // ---- East
  "iron-monk": {
    below: 0.6,
    cut: 0.3,
    incoming: (x) => {
      if (x.me.hp < x.me.hpMax * x.skill.below) x.out.mult *= 1 - x.skill.cut;
    },
    text: (s) => `Below ${pct(s.below)} HP you take ${pct(s.cut)} less damage.`,
  },
  "wandering-daoist": {
    drain: 1,
    outgoing: (x) => {
      if (x.mine === "guard" && (x.theirs === "strike" || x.theirs === "skill")) x.out.foeFocus -= x.skill.drain;
    },
    text: (s) => `When your Guard stops a Strike or a Skill, the attacker also loses ${s.drain} Focus.`,
  },
  "talisman-sage": {
    taken: 0.5,
    incoming: (x) => {
      if (x.mine === "charge" && x.theirs === "break") {
        x.out.cancel = false;
        x.out.mult *= x.skill.taken;
      }
    },
    text: (s) => `Break can't cancel your Charge: you take only ${pct(s.taken)} of its damage and still gain the Focus.`,
  },
  "plum-blossom": {
    base: 3.0,
    perSpeed: 0.012,
    skillMult: (me, s) => s.base + s.perSpeed * me.speed,
    text: (s) =>
      `Your Skill is a combo that grows with Speed: ${times(s.base)} plus ${times(s.perSpeed)} per Speed point ` +
      `(Speed 60: ${times(s.base + 60 * s.perSpeed)}) instead of ${times(T.skill)}.`,
  },
  "blind-sword-master": {
    vsGuard: 0.15,
    outgoing: (x) => {
      if (x.mine === "strike" && x.theirs === "guard") {
        x.out.base = x.skill.vsGuard;
        x.out.tag = "SIGHTLESS CUT";
      }
    },
    incoming: (x) => {
      if (x.mine === "strike" && x.theirs === "guard") Object.assign(x.out, { base: 0, tag: null });
    },
    text: (s) =>
      `Your Strike can't be countered: into a Guard it still deals ${times(s.vsGuard)} damage and takes no counter (the guard still gains its Focus).`,
  },
  // ---- North
  berserker: {
    per: 0.6,
    outgoing: (x) => {
      x.out.mult *= 1 + x.skill.per * (1 - Math.max(0, x.me.hp) / x.me.hpMax);
    },
    text: (s) => `Your damage rises as you lose HP: +${pct(s.per / 100)} for every 1% lost (at 40% HP: +${pct(s.per * 0.6)}).`,
  },
  "rune-priestess": {
    shield: 0.05,
    outgoing: (x) => {
      if (x.mine === "charge") x.out.shield = x.skill.shield;
    },
    text: (s) => `A Charge that isn't broken also raises a ward that absorbs ${pct(s.shield)} of your max HP (it doesn't stack).`,
  },
  "frost-witch": {
    drain: 2,
    outgoing: (x) => {
      if (lands(x)) x.out.foeFocus -= x.skill.drain;
    },
    text: (s) => `When your Skill lands (not into a Guard), the foe also loses ${s.drain} Focus.`,
  },
  "wolf-hunter": {
    below: 0.6,
    bonus: 0.6,
    outgoing: (x) => {
      if (x.mine === "strike" && x.foe.hp < x.foe.hpMax * x.skill.below) x.out.mult *= 1 + x.skill.bonus;
    },
    text: (s) => `Your Strikes hit ${pct(s.bonus)} harder against a foe below ${pct(s.below)} HP.`,
  },
  // ---- South
  "sun-guardian": {
    counter: 1.1,
    reflect: 1.6,
    outgoing: (x) => {
      if (x.mine === "guard" && x.theirs === "strike") x.out.base = x.skill.counter;
      if (x.mine === "guard" && x.theirs === "skill") Object.assign(x.out, { base: x.skill.reflect, tag: "REFLECT" });
    },
    text: (s) =>
      `Your Guard burns attackers: a parried Strike takes ${times(s.counter)} instead of ${times(ROLES[1].counter)}, ` +
      `and a Skill into your Guard hits its user for ${times(s.reflect)} Strike damage.`,
  },
  oracle: {
    taken: 0.6,
    incoming: (x) => {
      if (x.mine === "charge" && (x.theirs === "strike" || x.theirs === "skill")) x.out.mult *= x.skill.taken / T.vulnerable;
    },
    text: (s) => `Hits on you while you Charge deal ${times(s.taken)} instead of ${times(T.vulnerable)}.`,
  },
  "djinn-caller": {
    weaken: 0.4,
    outgoing: (x) => {
      if (lands(x)) x.out.weaken = x.skill.weaken;
    },
    text: (s) => `When your Skill lands (not into a Guard), the foe deals ${pct(s.weaken)} less damage next round.`,
  },
  "sand-dancer": {
    taken: 0.55,
    incoming: (x) => {
      if (x.mine === "break" && x.theirs === "strike") {
        x.out.mult *= x.skill.taken / T.vulnerable;
        x.out.tag = "MIRAGE";
      }
    },
    text: (s) => `Your Break half-slips Strikes: a Strike into your Break hits you for ${times(s.taken)} instead of ${times(T.vulnerable)}.`,
  },
};

/** The rule text of a class's signature skill, from the engine's own numbers ("" for classes without one). */
export const skillText = (slug) => (CLASS_SKILLS[slug] ? CLASS_SKILLS[slug].text(CLASS_SKILLS[slug]) : "");
