// The Clash duel. Each round both cards pick one of five moves at the same time, then both resolve at once:
//   Strike  beats Break and Charge; loses to Guard and Skill
//   Guard   stops Strike (parries and hits back) and Skill; loses to Break and Charge
//   Break   crushes Guard (and takes a Focus) and Charge (and cancels it); loses to Strike and Skill
//   Charge  gains Focus; anything that hits a charging card hits harder
//   Skill   costs 3 Focus and beats everything but Guard
// No move wins on its own, so good play is a mix and reading the opponent is the skill. The numbers live in
// rules.js and skills.js, and rulesText() writes the rules agents read from them, so the text is the engine.
// Randomness (crits, ±5% damage, sampling mixed picks) comes from per-round seeds: a match replays exactly from
// its seed and moves, and no pick can steer a later roll.
import { classOf } from "../classes.js";
import { rng, seedFrom } from "./rng.js";
import { ACTIONS, TUNING as T, ROLES } from "./rules.js";
import { CLASS_SKILLS } from "./skills.js";

export { ACTIONS, ROLES };
export const ENGINE = "clash-1"; // stored with every match so old replays keep their rules
const TOP_RARITY = 3; // Mythic cards (rarity 4) play at Legendary strength: only their art, name and number differ

/**
 * A fighter from a card: { region, role, awakened, rarity, level, power, defense, speed, luck, name?, stage? }.
 * mode "ranked" keeps level and rarity small (the ladder); "full" lets them count (dungeons, friendly fights).
 */
export function fighter(card, mode = "ranked") {
  const R = ROLES[card.role];
  const cls = classOf(card.region, card.role, card.awakened);
  const sc = T.scaling[mode] || T.scaling.ranked;
  const edge = (1 + sc.level * (card.level - 1)) * (1 + sc.rarity * Math.min(card.rarity, TOP_RARITY)) * (1 + (T.evolution[card.stage] ?? 0));
  const hpMax = T.hp * R.hp * (1 + T.stat * (card.defense - 50)) * edge;
  return {
    name: card.name || cls.name,
    cls: cls.slug,
    role: card.role,
    skill: CLASS_SKILLS[cls.slug] || null,
    hpMax,
    hp: hpMax,
    atk: T.strike * R.dmg * (1 + T.stat * (card.power - 50)) * edge,
    speed: card.speed,
    crit: Math.max(0, (R.critChance ?? T.critChance) + T.luckCrit * (card.luck - 50) + (CLASS_SKILLS[cls.slug]?.critBonus ?? 0)),
    critMult: R.critMult ?? T.critMult,
    focus: T.focusStart,
    focusCap: R.focusCap ?? T.focusCap,
    shield: 0,
    charges: 0, // Charges so far: each heal from Charging decays
    streak: 0, // Strikes landed in a row
    weakened: 0, // share of damage lost this round
    dealt: 0,
  };
}

const skillMult = (f) => (f.skill?.skillMult ? f.skill.skillMult(f, f.skill) : ROLES[f.role].skill ?? T.skill);
export const canAfford = (f, action) => action !== "skill" || f.focus >= T.skillCost;

/** What `me` playing `a` does to `foe` playing `b`, before class skills. */
function baseOutcome(me, foe, a, b) {
  const R = ROLES[me.role];
  const o = { base: 0, mult: 1, canCrit: false, forceCrit: false, focus: 0, foeFocus: 0, heal: 0, cancel: false, shield: 0, weaken: 0, tag: null };
  if (a === "strike") {
    if (b === "break" || b === "charge") Object.assign(o, { base: T.vulnerable, canCrit: true, focus: T.focusStrike, tag: "COUNTER-HIT" });
    else if (b === "strike" || b === "skill") Object.assign(o, { base: 1, canCrit: true, focus: T.focusStrike, tag: "HIT" });
  } else if (a === "guard") {
    if (b === "strike") Object.assign(o, { base: R.counter ?? T.counter, focus: T.focusGuard, heal: R.guardHeal ?? 0, tag: "PARRY" });
    else if (b === "skill") Object.assign(o, { focus: T.focusGuard, heal: R.guardHeal ?? 0, tag: "SKILL BLOCKED" });
  } else if (a === "break") {
    if (b === "guard") Object.assign(o, { base: T.breakGuard, foeFocus: -T.focusBroken, tag: "GUARD CRUSH" });
    else if (b === "charge") Object.assign(o, { base: T.breakCharge, cancel: true, tag: "CHARGE BROKEN" });
  } else if (a === "skill") {
    if (b === "guard") o.base = ROLES[foe.role].chipTaken ?? T.chip;
    else Object.assign(o, { base: skillMult(me) * (b === "charge" ? T.vulnerable : 1), canCrit: true, tag: "SKILL" });
  }
  return o;
}

function absorb(f, dmg) {
  const s = Math.min(f.shield, dmg);
  f.shield -= s;
  f.hp -= dmg - s;
}

/**
 * Resolves one round in place and returns its log entry. `rand` is the round's generator, or null for expected
 * values (bots looking ahead): then crits count by their odds and damage doesn't vary.
 */
export function resolveRound(fs, acts, round, rand = null) {
  const sd = round >= T.suddenDeath ? 1 + T.suddenDeathStep * (round - T.suddenDeath + 1) : 1;
  const healing = round < T.suddenDeath;
  for (const i of [0, 1]) if (acts[i] === "skill") fs[i].focus -= T.skillCost;

  const outs = [0, 1].map((i) => baseOutcome(fs[i], fs[1 - i], acts[i], acts[1 - i]));
  const hook = (i, name, out) => {
    const sk = fs[i].skill;
    if (sk?.[name]) sk[name]({ me: fs[i], foe: fs[1 - i], mine: acts[i], theirs: acts[1 - i], out, skill: sk });
  };
  for (const i of [0, 1]) hook(i, "outgoing", outs[i]);
  for (const i of [0, 1]) hook(i, "incoming", outs[1 - i]);

  // damage each side deals
  const dmg = [0, 0];
  const crit = [false, false];
  for (const i of [0, 1]) {
    const me = fs[i];
    const foe = fs[1 - i];
    const o = outs[i];
    if (o.base <= 0) continue;
    let d = me.atk * o.base * o.mult * sd * (1 - me.weakened);
    if (ROLES[me.role].beats === foe.role) d *= 1 + T.roleEdge;
    if (o.canCrit || o.forceCrit) {
      if (!rand) d *= o.forceCrit ? me.critMult : 1 + me.crit * (me.critMult - 1);
      else if (o.forceCrit || rand() < me.crit) {
        d *= me.critMult;
        crit[i] = true;
      }
    }
    if (rand) d *= 1 - T.variance + 2 * T.variance * rand();
    dmg[i] = d;
  }

  // if both blows would be lethal, the faster one lands first: an Assassin's Strike, then Speed, then a coin
  const lethal = [0, 1].map((i) => fs[1 - i].hp + fs[1 - i].shield - dmg[i] <= 0);
  let first = null;
  if (lethal[0] && lethal[1]) {
    const prio = (i) => (ROLES[fs[i].role].firstStrike && acts[i] === "strike" ? 1 : 0);
    first = prio(0) !== prio(1) ? (prio(0) ? 0 : 1)
      : fs[0].speed !== fs[1].speed ? (fs[0].speed > fs[1].speed ? 0 : 1)
      : rand ? (rand() < 0.5 ? 0 : 1) : null; // looking ahead with a dead heat: count it as a double KO
  }
  const landed = [false, false];
  for (const i of first === null ? [0, 1] : [first, 1 - first]) {
    if (first !== null && i !== first && fs[i].hp <= 0) continue; // knocked out before it could hit
    if (dmg[i] > 0) {
      absorb(fs[1 - i], dmg[i]);
      fs[i].dealt += dmg[i];
      landed[i] = true;
    }
  }

  // Focus, healing, wards and next round's effects
  const canceled = [outs[1].cancel, outs[0].cancel];
  for (const i of [0, 1]) {
    const me = fs[i];
    const R = ROLES[me.role];
    const o = outs[i];
    me.weakened = 0;
    if (me.hp <= 0) continue;
    let gain = o.focus;
    if (acts[i] === "charge" && !canceled[i]) {
      gain += R.focusCharge ?? T.focusCharge;
      if (healing && R.chargeHeal) me.hp += me.hpMax * R.chargeHeal * T.healDecay ** me.charges;
      if (o.shield) me.shield = Math.max(me.shield, me.hpMax * o.shield);
    }
    if (acts[i] === "charge") me.charges += 1;
    if (healing) me.hp += me.hpMax * (o.heal + (R.regen ?? 0));
    me.hp = Math.min(me.hpMax, me.hp);
    me.focus = Math.max(0, Math.min(me.focusCap, me.focus + gain + outs[1 - i].foeFocus));
    me.streak = acts[i] === "strike" && landed[i] ? me.streak + 1 : 0;
  }
  for (const i of [0, 1]) if (outs[i].weaken && landed[i]) fs[1 - i].weakened = outs[i].weaken;

  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    round,
    picks: [...acts],
    tags: outs.map((o, i) => (landed[i] || o.base === 0 ? o.tag : null)),
    dmg: dmg.map((d, i) => (landed[i] ? r1(d) : 0)),
    crit,
    hp: fs.map((f) => r1(Math.max(0, f.hp))),
    focus: fs.map((f) => f.focus),
    suddenDeath: sd > 1,
  };
}

/** What a side may see before picking: everything public, never the opponent's pick or program. */
export function viewFor(fs, history, i, round) {
  const side = (f, h) => {
    const rate = Object.fromEntries(ACTIONS.map((a) => [a, h.length ? (100 * h.filter((x) => x === a).length) / h.length : 0]));
    return {
      hp: (100 * Math.max(0, f.hp)) / f.hpMax,
      focus: f.focus,
      role: ROLES[f.role].name.toLowerCase(),
      cls: f.cls,
      last: h[h.length - 1] || "none",
      prev: h[h.length - 2] || "none",
      rate,
    };
  };
  return { round, suddenDeath: round >= T.suddenDeath, me: side(fs[i], history[i]), opp: side(fs[1 - i], history[1 - i]) };
}

/** A pick is an action name or a mix { action: weight }; unaffordable moves drop out, then it is sampled. */
export function samplePick(pick, f, rand) {
  const mix = typeof pick === "string" ? { [pick]: 1 } : pick || {};
  const options = ACTIONS.filter((a) => (mix[a] || 0) > 0 && canAfford(f, a));
  if (!options.length) return "guard";
  const total = options.reduce((s, a) => s + mix[a], 0);
  let x = rand() * total;
  for (const a of options) if ((x -= mix[a]) < 0) return a;
  return options[options.length - 1];
}

function result(fs) {
  const [a, b] = fs;
  if (a.hp <= 0 && b.hp > 0) return { winner: 1, reason: "KO" };
  if (b.hp <= 0 && a.hp > 0) return { winner: 0, reason: "KO" };
  if (a.hp <= 0 && b.hp <= 0) return { winner: null, reason: "double KO" };
  const sa = a.hp / a.hpMax;
  const sb = b.hp / b.hpMax;
  if (Math.abs(sa - sb) > 1e-9) return { winner: sa > sb ? 0 : 1, reason: "time: higher HP share" };
  if (Math.abs(a.dealt - b.dealt) > 1e-9) return { winner: a.dealt > b.dealt ? 0 : 1, reason: "time: more damage dealt" };
  return { winner: null, reason: "draw" };
}

// ---- a match, round by round. Live duels step it as moves arrive; replays and the ladder run it to the end.
// `seed` should stay secret until the match ends (publish its hash first).

export function startMatch(cards, mode = "ranked") {
  return { mode, seed: null, fs: cards.map((c) => fighter(c, mode)), history: [[], []], log: [] };
}

export const nextRound = (m) => m.log.length + 1;
export const isOver = (m) => m.fs[0].hp <= 0 || m.fs[1].hp <= 0 || m.log.length >= T.maxRounds;
export const viewOf = (m, side) => viewFor(m.fs, m.history, side, nextRound(m));

/** Plays the next round from two choices (a move or a mix each) and returns its log entry. */
export function stepRound(m, choices, seed) {
  const round = nextRound(m);
  const picks = [0, 1].map((i) => samplePick(choices[i], m.fs[i], rng(seedFrom(`${seed}:${round}:pick:${i}`))));
  const ev = resolveRound(m.fs, picks, round, rng(seedFrom(`${seed}:${round}`)));
  m.log.push(ev);
  m.history[0].push(picks[0]);
  m.history[1].push(picks[1]);
  return ev;
}

export const outcome = (m) => ({ engine: ENGINE, mode: m.mode, ...result(m.fs), rounds: m.log.length, log: m.log });

/**
 * Plays a whole match. `pickers[i](view, fighters, side)` returns a move or a mix and sees only public state.
 * Returns { winner: 0 | 1 | null, reason, rounds, log }.
 */
export function playMatch(cards, pickers, seed, { mode = "ranked" } = {}) {
  const m = startMatch(cards, mode);
  while (!isOver(m)) stepRound(m, [0, 1].map((i) => pickers[i](viewOf(m, i), m.fs, i)), seed);
  return outcome(m);
}

/** The match after the given moves were played: replays stored matches and resumes live ones. */
export function replayTo(cards, picks, seed, { mode = "ranked" } = {}) {
  const m = startMatch(cards, mode);
  for (const p of picks) {
    if (isOver(m)) break;
    stepRound(m, p, seed);
  }
  return m;
}

/** Replays a finished match from its seed and the moves in its log; the result must match the original. */
export const replayMatch = (cards, picks, seed, opts) => outcome(replayTo(cards, picks, seed, opts));
