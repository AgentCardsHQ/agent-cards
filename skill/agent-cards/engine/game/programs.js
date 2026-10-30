// Rule programs: how a card plays when its agent isn't there (the ranked ladder, live timeouts, autopilot).
// Up to 12 rules, checked top to bottom; the first rule whose conditions all hold picks the move, either one move
// or a weighted mix that is sampled from the match's seeded randomness. Rules read only public state, and a Skill
// in a mix is skipped while the card has less than 3 Focus.
//
// Text form, one rule per line ("#" starts a comment):
//   opp.hp <= 12 -> strike
//   me.focus >= 3 and opp.last == charge -> skill
//   opp.focus >= 3 -> guard 60, break 25, strike 15
//   always -> strike 40, guard 40, break 20
// JSON form: { "rules": [ { "if": ["opp.hp <= 12"], "then": "strike" }, { "then": { "strike": 40, "guard": 60 } } ] }
import { ACTIONS, TUNING } from "./rules.js";

export const LIMITS = { rules: 12, conditions: 4, nameLength: 40 };
const OPS = ["<=", ">=", "==", "!=", "<", ">"];
const MOVE_VARS = ["me.last", "opp.last", "me.prev", "opp.prev"];
const NUMBER_VARS = [
  "round", "lead", "suddendeath", "me.hp", "opp.hp", "me.focus", "opp.focus",
  ...ACTIONS.map((a) => `opp.rate.${a}`), ...ACTIONS.map((a) => `me.rate.${a}`),
];
const MOVES = [...ACTIONS, "none"];

/** What each value means, for the rules text agents read. */
export const VALUES = {
  round: "the round, 1-16",
  "me.hp / opp.hp": "HP left, 0-100 (%)",
  "me.focus / opp.focus": "Focus, 0-6",
  lead: "me.hp minus opp.hp",
  suddendeath: "1 from round 10, else 0",
  "me.last / opp.last": "the last move (strike, guard, break, charge, skill, or none before round 2)",
  "me.prev / opp.prev": "the move before that",
  "opp.rate.<move> / me.rate.<move>": "share of that side's moves so far that were <move>, 0-100 (%)",
};

export class ProgramError extends Error {}
const bad = (why) => {
  throw new ProgramError(why);
};

function parseCondition(text) {
  const m = /^\s*([a-z.]+)\s*(<=|>=|==|!=|<|>)\s*([a-z0-9.-]+)\s*$/i.exec(text);
  if (!m) bad(`can't read the condition "${text}": write it like "opp.focus >= 3"`);
  const [, left, op, right] = [m[0], m[1].toLowerCase(), m[2], m[3].toLowerCase()];
  if (MOVE_VARS.includes(left)) {
    if (op !== "==" && op !== "!=") bad(`"${left}" is a move: compare it with == or !=`);
    if (!MOVES.includes(right)) bad(`"${right}" is not a move (${MOVES.join(", ")})`);
    return { left, op, right };
  }
  if (!NUMBER_VARS.includes(left)) bad(`unknown value "${left}"`);
  if (/^-?\d+(\.\d+)?$/.test(right)) return { left, op, right: Number(right) };
  if (NUMBER_VARS.includes(right)) return { left, op, right };
  return bad(`compare "${left}" with a number or another value, not "${right}"`);
}

function parseMix(then) {
  const mix = {};
  const add = (move, weight) => {
    const a = String(move).trim().toLowerCase();
    if (!ACTIONS.includes(a)) bad(`"${move}" is not a move (${ACTIONS.join(", ")})`);
    const w = Number(weight);
    if (!Number.isInteger(w) || w < 0 || w > 100) bad(`the weight of ${a} must be a whole number from 0 to 100`);
    if (w > 0) mix[a] = (mix[a] || 0) + w;
  };
  if (typeof then === "string") {
    for (const part of then.split(",")) {
      const [move, weight = "1", extra] = part.trim().split(/\s+/);
      if (extra !== undefined || !move) bad(`can't read "${part.trim()}": write moves like "guard 60, break 40"`);
      add(move, weight);
    }
  } else if (then && typeof then === "object") {
    for (const [move, weight] of Object.entries(then)) add(move, weight);
  } else bad("every rule needs a move or a mix after ->");
  if (!Object.keys(mix).length) bad("a rule's mix needs at least one move with a weight above 0");
  return mix;
}

/** Reads a program in text or JSON form and checks it; throws ProgramError with a reason an agent can act on. */
export function parseProgram(input, name = "my program") {
  const raw = typeof input === "string" ? input : input?.rules;
  let rules;
  if (typeof raw === "string") {
    rules = raw.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((line, n) => {
      const [cond, then, extra] = line.split("->");
      if (then === undefined || extra !== undefined) bad(`line ${n + 1}: write "conditions -> moves"`);
      const c = cond.trim().toLowerCase();
      return { if: c === "always" || c === "" ? [] : c.split(/\s+and\s+/), then: then.trim() };
    });
  } else if (Array.isArray(raw)) rules = raw;
  else bad('a program is text ("conditions -> moves" per line) or { "rules": [...] }');
  if (!rules.length) bad("the program has no rules");
  if (rules.length > LIMITS.rules) bad(`at most ${LIMITS.rules} rules (this one has ${rules.length})`);
  const out = rules.map((r, n) => {
    try {
      const when = (r.if || []).map(parseCondition);
      if (when.length > LIMITS.conditions) bad(`at most ${LIMITS.conditions} conditions per rule`);
      return { when, mix: parseMix(r.then) };
    } catch (e) {
      if (e instanceof ProgramError) bad(`rule ${n + 1}: ${e.message}`);
      throw e;
    }
  });
  const title = String(typeof input === "object" && input?.name ? input.name : name).slice(0, LIMITS.nameLength);
  return { name: title, rules: out };
}

/** A program back in text form, one rule per line. */
export function programText(p) {
  return p.rules
    .map((r) => {
      const cond = r.when.length ? r.when.map((c) => `${c.left} ${c.op} ${c.right}`).join(" and ") : "always";
      const mix = Object.entries(r.mix).map(([a, w]) => (Object.keys(r.mix).length === 1 && w === 1 ? a : `${a} ${w}`)).join(", ");
      return `${cond} -> ${mix}`;
    })
    .join("\n");
}

function read(name, view) {
  if (name === "round") return view.round;
  if (name === "lead") return view.me.hp - view.opp.hp;
  if (name === "suddendeath") return view.suddenDeath ? 1 : 0;
  const [who, key, sub] = name.split(".");
  const side = who === "me" ? view.me : view.opp;
  return key === "rate" ? side.rate[sub] : side[key];
}

function holds(c, view) {
  const l = read(c.left, view);
  const r = typeof c.right === "number" || MOVES.includes(c.right) && MOVE_VARS.includes(c.left) ? c.right : read(c.right, view);
  switch (c.op) {
    case "<": return l < r;
    case "<=": return l <= r;
    case ">": return l > r;
    case ">=": return l >= r;
    case "==": return l === r;
    default: return l !== r;
  }
}

/** The move or mix a program picks in this view; if no rule fires, an even Strike/Guard/Break mix. */
export function decide(program, view) {
  for (const rule of program.rules) {
    if (!rule.when.every((c) => holds(c, view))) continue;
    const mix = Object.fromEntries(Object.entries(rule.mix).filter(([a]) => a !== "skill" || view.me.focus >= TUNING.skillCost));
    if (Object.keys(mix).length) return mix;
  }
  return { strike: 1, guard: 1, break: 1 };
}

// Ready-made programs. "balanced" is every new card's default; the others are styles to start from.
export const STARTERS = {
  balanced: `
    opp.hp <= 10 -> strike 70, skill 30
    opp.focus >= 3 -> guard 50, break 25, strike 25
    me.focus >= 3 and opp.last == charge -> skill
    opp.last == charge -> strike 60, break 40
    opp.rate.charge >= 25 -> strike 50, break 30, guard 20
    me.focus >= 3 -> skill 40, strike 30, break 30
    opp.last == guard and opp.prev == guard -> break 70, strike 30
    always -> strike 35, guard 35, break 20, charge 10`,
  aggressor: `
    me.focus >= 3 -> skill 60, strike 40
    opp.focus >= 3 -> guard 40, strike 40, break 20
    always -> strike 50, break 30, guard 10, charge 10`,
  turtle: `
    opp.focus >= 3 -> guard 80, break 20
    me.focus >= 3 and opp.last == guard -> break 60, skill 40
    me.focus >= 3 -> skill 50, guard 50
    always -> guard 50, strike 25, charge 25`,
  charger: `
    me.focus >= 3 -> skill 60, guard 40
    opp.focus >= 3 -> guard 60, strike 40
    opp.last == guard -> charge 60, break 40
    always -> charge 30, strike 35, guard 35`,
  reader: `
    opp.focus >= 3 -> guard 60, break 20, strike 20
    opp.rate.guard >= 40 -> break 60, charge 25, strike 15
    opp.rate.strike >= 45 -> guard 60, skill 20, break 20
    opp.rate.break >= 35 -> strike 70, skill 30
    opp.rate.charge >= 30 -> strike 60, break 40
    me.focus >= 3 -> skill 40, strike 30, guard 30
    always -> strike 35, guard 35, break 30`,
  sniper: `
    opp.hp <= 20 and me.focus >= 3 -> skill
    opp.focus >= 3 -> guard 70, break 30
    opp.last == charge -> strike 60, break 40
    opp.rate.charge >= 25 -> strike 55, break 45
    me.focus >= 3 -> skill 60, strike 40
    always -> strike 40, guard 30, break 20, charge 10`,
};

export const starter = (name) => parseProgram(STARTERS[name], name);
