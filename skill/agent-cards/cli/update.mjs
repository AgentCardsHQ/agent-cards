// kart update's checks and file moves, kept separate from kart.mjs so they can be tested without a real download,
// tar or network (worker/test/kart-update.test.mjs). kart.mjs wires these to the site, GitHub and the filesystem; it
// never runs this on its own, only when the command is run. No dependencies (Node 20+).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Where kart's own GitHub release assets live, overridable for development and tests (never for the site: that one
 *  is release.json's). */
export const GITHUB_RELEASES = (process.env.AGENT_CARDS_TEST === "1" && process.env.AGENT_CARDS_GITHUB) || "https://github.com/AgentCardsHQ/agent-cards/releases/download";

/** True when `a` is a strictly newer version than `b` ("0.24.0" > "0.23.1"); a missing or non-numeric part counts
 *  as 0, so "1.2" is newer than "1.1.9". */
export function versionNewer(a, b) {
  const parts = (v) => String(v ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i] || 0, pb[i] || 0];
    if (x !== y) return x > y;
  }
  return false;
}

/** Why kart refuses to install `newVersion` over the running `currentVersion`, or null to proceed. */
export function downgradeProblem(newVersion, currentVersion) {
  if (!newVersion) return "the package has no version kart can read: refusing";
  if (!versionNewer(newVersion, currentVersion)) return `the package is version ${newVersion}, not newer than the installed ${currentVersion}: refusing to downgrade`;
  return null;
}

/**
 * Why kart refuses the downloaded package, or null to proceed: `got` is its own sha256; `site` is what the site's
 * own agent-cards.tgz.sha256 says; `github` is the GitHub release's .sha256 for the same version, or null when that
 * request failed or 404'd (no second source); `pin` is AGENT_CARDS_SHA256 when the human set one, honoured the same
 * way install.sh and install.ps1 do. Both the site and GitHub must agree with the bytes kart has.
 */
export function updateProblem({ got, site, github, pin }) {
  if (pin && got !== pin) return `the site serves a package with sha256 ${got}, not the pinned ${pin} (a newer release, or not the package you meant): refusing`;
  if (!site) return "the site gave no sha256 to check the package against: refusing";
  if (got !== site) return `the site's package is sha256 ${got}, but its own agent-cards.tgz.sha256 says ${site}: refusing to trust it`;
  if (!github) return "no matching GitHub release sha256 for this version: refusing without a second source";
  if (got !== github) return `the site's package is sha256 ${got}, but the GitHub release says ${github}: refusing to trust it`;
  return null;
}

/** The first tar entry name (as `tar -tzf` lists them) that would land outside `base` once extracted there: an
 *  absolute path, a Windows drive letter, a UNC path, or a name whose ".." walks out of it. Null when every name
 *  is safe to extract. */
export function escapingTarPath(names, base) {
  for (const raw of names) {
    const name = String(raw).replace(/^(\.\/)+/, "");
    if (!name || name === ".") continue;
    if (path.isAbsolute(name) || /^[a-zA-Z]:[\\/]/.test(name) || name.startsWith("\\\\")) return raw;
    const resolved = path.resolve(base, name);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return raw;
  }
  return null;
}

/** Whether kart should tell the human about `latest` once: it must be newer than `current`, and not the version
 *  already nagged about on this server (`lastNagged`, null when never). */
export function shouldNag(latest, current, lastNagged) {
  return !!latest && versionNewer(latest, current) && latest !== lastNagged;
}

/**
 * Backs up the installed skill, installs the new one, and rolls back if it doesn't run. `backup` moves the install
 * aside and resolves a `restore` function; `install` puts the new package where it was; `verify` resolves true once
 * the installed copy runs; `cleanup` (optional) runs only once installed and verified. Returns
 * { ok, rolledBack, error }; `error` only when install or verify threw.
 */
export async function swapAndVerify({ backup, install, verify, cleanup }) {
  const restore = await backup();
  try {
    await install();
    if (await verify()) {
      await cleanup?.();
      return { ok: true, rolledBack: false };
    }
    await restore();
    return { ok: false, rolledBack: true };
  } catch (e) {
    await restore();
    return { ok: false, rolledBack: true, error: String(e?.message || e) };
  }
}

// ---- tar and the extracted package, wired to the real filesystem and a real tar binary

/** Windows has no "tar" on PATH by default, but every build since 1803 ships tar.exe in System32 (install.ps1 uses
 *  the same path); macOS and Linux have "tar" on PATH. Never run through a shell: the path and every argument go to
 *  spawnSync as their own array entry. */
const tarBin = () => (process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar");

/** The names `tar -tzf` lists for `file`, one per line; throws if tar can't read it. */
export function listTar(file) {
  const r = spawnSync(tarBin(), ["-tzf", file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`could not list the package (tar exit ${r.status}): ${String(r.stderr || "").trim().slice(0, 200)}`);
  return String(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Extracts `file` into `dir` (already created); throws if tar fails. Call only once escapingTarPath found nothing. */
export function extractTar(file, dir) {
  const r = spawnSync(tarBin(), ["-xzf", file, "-C", dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`could not unpack the package (tar exit ${r.status}): ${String(r.stderr || "").trim().slice(0, 200)}`);
}

/** cli/release.json's version if it has one, else kart.mjs's VERSION; null when neither does. */
export function packageVersion(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, "cli", "release.json"), "utf8")).version;
    if (typeof v === "string" && v) return v;
  } catch {
    // no release.json, or not JSON: kart.mjs has the version
  }
  try {
    return /\bVERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(dir, "cli", "kart.mjs"), "utf8"))?.[1] || null;
  } catch {
    return null;
  }
}

/** Runs `node <dir>/cli/kart.mjs version` and reports whether it printed "ok": true, the same check install.sh and
 *  install.ps1 make before replacing anything. */
export function kartRuns(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, "cli", "kart.mjs"), "version"], { encoding: "utf8" });
  try {
    return JSON.parse(r.stdout)?.ok === true;
  } catch {
    return false;
  }
}

/** Moves `dir` aside. Returns { restore, cleanup }: restore removes whatever is at `dir` now and puts the backup
 *  back; cleanup deletes the backup once the new install is confirmed good. */
export function backupDir(dir) {
  const backup = `${dir}.bak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.renameSync(dir, backup);
  return {
    restore: async () => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(backup, dir);
    },
    cleanup: async () => fs.rmSync(backup, { recursive: true, force: true }),
  };
}
