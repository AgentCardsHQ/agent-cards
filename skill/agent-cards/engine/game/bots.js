// Players the simulator (and later the house AI) can field. A picker is (view, fighters, side) => move or mix.
// "equilibrium" looks one round ahead: it scores all 25 move pairs and plays the mix that is safest against any
// reply (a zero-sum solve). It is a strong, unexploitable baseline, not an opponent model.
import { ACTIONS, canAfford, resolveRound } from "./clash.js";
import { decide } from "./programs.js";

const FOCUS_VALUE = 0.4; // one Focus ~ 0.4 Strike, as the research prototype found

function score(me, op) {
  if (op.hp <= 0 && me.hp > 0) return 10;
  if (me.hp <= 0 && op.hp > 0) return -10;
  if (me.hp <= 0 && op.hp <= 0) return 0;
  return (me.hp + me.shield) / me.hpMax - (op.hp + op.shield) / op.hpMax
    + FOCUS_VALUE * ((me.focus * me.atk) / op.hpMax - (op.focus * op.atk) / me.hpMax);
}

/** The row player's safest mix for payoff matrix M (regret matching+, averaged). */
export function solveZeroSum(M, iters = 300) {
  const m = M.length;
  const n = M[0].length;
  const rr = new Array(m).fill(0);
  const rc = new Array(n).fill(0);
  const avg = new Array(m).fill(0);
  const strat = (r) => {
    const pos = r.map((v) => Math.max(0, v));
    const s = pos.reduce((a, b) => a + b, 0);
    return s > 0 ? pos.map((v) => v / s) : r.map(() => 1 / r.length);
  };
  for (let t = 1; t <= iters; t++) {
    const x = strat(rr);
    const y = strat(rc);
    const rowVal = M.map((row) => row.reduce((s, v, j) => s + v * y[j], 0));
    const colVal = M[0].map((_, j) => -M.reduce((s, row, i) => s + row[j] * x[i], 0));
    const vr = rowVal.reduce((s, v, i) => s + v * x[i], 0);
    const vc = colVal.reduce((s, v, j) => s + v * y[j], 0);
    for (let i = 0; i < m; i++) rr[i] = Math.max(0, rr[i] + rowVal[i] - vr);
    for (let j = 0; j < n; j++) rc[j] = Math.max(0, rc[j] + colVal[j] - vc);
    for (let i = 0; i < m; i++) avg[i] += t * x[i];
  }
  const s = avg.reduce((a, b) => a + b, 0);
  return avg.map((v) => v / s);
}

export function equilibrium({ iters = 300 } = {}) {
  return (view, fs, side) => {
    const me = fs[side];
    const op = fs[1 - side];
    const mine = ACTIONS.filter((a) => canAfford(me, a));
    const theirs = ACTIONS.filter((b) => canAfford(op, b));
    const M = mine.map((a) =>
      theirs.map((b) => {
        const copy = [{ ...fs[0] }, { ...fs[1] }];
        resolveRound(copy, side === 0 ? [a, b] : [b, a], view.round, null);
        return score(copy[side], copy[1 - side]);
      }),
    );
    const x = solveZeroSum(M, iters);
    return Object.fromEntries(mine.map((a, k) => [a, x[k]]));
  };
}

/** "Sounds reasonable but predictable": attack-minded, Skill whenever it can. How LLMs tend to play cold. */
export const habit = () => (view) => {
  if (view.me.focus >= 3) return { skill: 60, strike: 25, guard: 15 };
  if (view.me.hp < 35) return { charge: 30, guard: 45, strike: 25 };
  if (view.opp.focus >= 3) return { guard: 50, strike: 30, break: 20 };
  return { strike: 45, guard: 20, break: 15, charge: 20 };
};

export const uniform = () => () => ({ strike: 1, guard: 1, break: 1, charge: 1, skill: 1 });

/** Mostly sound, sometimes habit: a blend of the two mixes. */
export function decent(share = 0.7) {
  const eq = equilibrium();
  const h = habit();
  return (view, fs, side) => {
    const a = eq(view, fs, side);
    const b = h(view);
    const total = Object.values(b).reduce((s, v) => s + v, 0);
    return Object.fromEntries(ACTIONS.map((m) => [m, share * (a[m] || 0) + ((1 - share) * (b[m] || 0)) / total]));
  };
}

export const fromProgram = (program) => (view) => decide(program, view);
