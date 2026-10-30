#!/usr/bin/env bash
# Installs the Agent Cards skill: downloads the package, verifies its checksum, installs it to
# ~/.agents/skills/agent-cards, puts a `kart` command in ~/.local/bin and prints the package's sha256.
#   curl -fsSL https://SITE/skill/install.sh | bash
# Pinned: with AGENT_CARDS_SHA256 set to a release's sha256 you got somewhere other than this site (the release post),
# the package must also have exactly that hash, so the site can't hand you different code:
#   curl -fsSL https://SITE/skill/install.sh | AGENT_CARDS_SHA256=<sha256> bash
# Windows: in PowerShell, irm https://SITE/skill/install.ps1 | iex (this script also runs in Git Bash).
set -euo pipefail
SITE="${AGENT_CARDS_SITE:-https://SITE}"
DIR="${AGENT_CARDS_DIR:-$HOME/.agents/skills/agent-cards}"
BIN="${AGENT_CARDS_BIN:-$HOME/.local/bin}"
PIN="$(printf '%s' "${AGENT_CARDS_SHA256:-}" | tr 'A-F' 'a-f')"

command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required." >&2; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js 20+ is required." >&2; exit 1; }
case "$PIN" in
  "") ;;
  *[!0-9a-f]*) echo "AGENT_CARDS_SHA256 must be a sha256: 64 hex characters." >&2; exit 1;;
  *) [ "${#PIN}" -eq 64 ] || { echo "AGENT_CARDS_SHA256 must be a sha256: 64 hex characters." >&2; exit 1; };;
esac

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$SITE/skill/agent-cards.tgz" -o "$tmp/agent-cards.tgz"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/agent-cards.tgz" | cut -d' ' -f1)"
else got="$(shasum -a 256 "$tmp/agent-cards.tgz" | cut -d' ' -f1)"; fi
want="$(curl -fsSL "$SITE/skill/agent-cards.tgz.sha256" | cut -c1-64)"
[ "$got" = "$want" ] || { echo "Checksum mismatch, installation aborted." >&2; exit 1; }
# the site's .sha256 comes from the site too: a pin is a hash it didn't hand out
[ -z "$PIN" ] || [ "$got" = "$PIN" ] || { echo "The site serves a package with sha256 $got, not the pinned $PIN (a newer release, or not the package you meant): installation aborted." >&2; exit 1; }

tar -xzf "$tmp/agent-cards.tgz" -C "$tmp"
[ -f "$tmp/agent-cards/SKILL.md" ] || { echo "Broken package." >&2; exit 1; }
# kart says "ok": true when it runs; a kart that can't find its files can exit quietly with nothing
says_ok() { case "$1" in *'"ok": true'* | *'"ok":true'*) return 0;; esac; return 1; }
# it must run on this machine before it replaces anything
says_ok "$(node "$tmp/agent-cards/cli/kart.mjs" version 2>&1 || true)" || { echo "kart doesn't run on this machine (node $tmp/agent-cards/cli/kart.mjs version): installation aborted." >&2; exit 1; }
mkdir -p "$(dirname "$DIR")" "$BIN"
rm -rf "$DIR"; cp -R "$tmp/agent-cards" "$DIR"
chmod +x "$DIR/cli/kart.mjs"
# a small script, not a link: Git Bash's ln -s makes a copy, and kart.mjs copied away from its .mjs name, guard.mjs
# and release.json runs as CommonJS and prints nothing. The old link goes first, or this would write through it
rm -f "$BIN/kart"
{ echo '#!/usr/bin/env bash'; printf 'exec node %q "$@"\n' "$DIR/cli/kart.mjs"; } > "$BIN/kart"
chmod +x "$BIN/kart"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    # kart.cmd for cmd and PowerShell; %USERPROFILE% keeps a non-ASCII user name out of a file cmd reads in its code page
    win="$(cygpath -w "$DIR/cli/kart.mjs")"
    if [ -n "${USERPROFILE:-}" ]; then
      prof="$(cygpath -w "$USERPROFILE")"
      case "$win" in "$prof"\\*) win="%USERPROFILE%${win#"$prof"}";; esac
    fi
    printf '@node "%s" %%*\r\n' "$win" > "$BIN/kart.cmd";;
esac
out="$("$BIN/kart" version 2>&1 || true)"
printf '%s\n' "$out"
says_ok "$out" || { echo "kart is in $DIR, but $BIN/kart doesn't run it (kart version printed no \"ok\": true): installation incomplete." >&2; exit 1; }
echo "Installed to $DIR (read SKILL.md). Package sha256: $got$([ -n "$PIN" ] && echo " (as pinned)" || true)"
echo "Next: kart preview"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Note: add $BIN to your PATH";; esac
