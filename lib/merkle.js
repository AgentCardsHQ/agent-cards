// The Merkle tree of a season's pool payouts, as RewardPool checks them: one leaf per wallet,
// keccak256(keccak256(abi.encode(pool, season, wallet, amount))) (bound to the RewardPool contract and the season, so
// a list funded under another season or pool pays nobody twice; hashed twice, so no pair of inner nodes can pass for a
// leaf), and every inner node the keccak256 of its two children in ascending order (OpenZeppelin's MerkleProof). The
// leaves are sorted first, so the same payouts always give the same root. A node left without a partner moves up a
// level as it is.
import { ethers } from "ethers";

const coder = ethers.AbiCoder.defaultAbiCoder();

/** The contract and season a tree is for, checked: { pool, season }. */
function bound({ pool, season } = {}) {
  if (!ethers.isAddress(pool)) throw new Error("a payout tree is bound to the RewardPool contract: pool must be its address");
  if (!(Number.isInteger(Number(season)) && Number(season) >= 1)) throw new Error("a payout tree is bound to a season: season must be 1 or later");
  return { pool: ethers.getAddress(pool), season: BigInt(season) };
}

/** A payout's leaf, RewardPool.leaf(season, wallet, amount) in the pool at `pool`. */
export function leafOf(at, wallet, amount) {
  const b = bound(at);
  return ethers.keccak256(ethers.keccak256(coder.encode(["address", "uint256", "address", "uint256"], [b.pool, b.season, wallet, BigInt(amount)])));
}

const parent = (a, b) => ethers.keccak256(ethers.concat(a < b ? [a, b] : [b, a]));

/**
 * The tree of `entries` ([{ wallet, amount }], one per wallet) for season `season` of the pool at `pool`:
 * { root, proofs } with proofs keyed by the lowercase wallet. An empty list has no root (null): there is nothing to fund.
 */
export function merkleTree(entries, at) {
  const b = bound(at);
  const leaves = entries.map((e) => ({ wallet: e.wallet.toLowerCase(), hash: leafOf(b, e.wallet, e.amount) }));
  if (new Set(leaves.map((l) => l.wallet)).size !== leaves.length) throw new Error("one leaf per wallet: add a wallet's payouts up first");
  leaves.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const proofs = new Map(leaves.map((l) => [l.wallet, []]));
  // where each wallet's node sits on the current level
  let level = leaves.map((l) => l.hash);
  let at_ = new Map(leaves.map((l, i) => [l.wallet, i]));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? parent(level[i], level[i + 1]) : level[i]);
    for (const [wallet, i] of at_) {
      const sibling = i % 2 === 0 ? i + 1 : i - 1;
      if (sibling < level.length) proofs.get(wallet).push(level[sibling]);
      at_.set(wallet, Math.floor(i / 2));
    }
    level = next;
  }
  return { root: level[0] ?? null, proofs };
}

/** Whether `proof` leads from (wallet, amount) in season `at.season` of pool `at.pool` to `root`, as MerkleProof.verify walks it. */
export function verifyProof(proof, root, at, wallet, amount) {
  let h = leafOf(at, wallet, amount);
  for (const p of proof) h = parent(h, p);
  return h === String(root).toLowerCase();
}
