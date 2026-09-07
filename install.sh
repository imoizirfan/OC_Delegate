#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"

# Editor hooks are OPT-IN. Without --with-hooks this script touches nothing
# outside opencode's config, ~/.claude/skills, and ~/.local/bin — writing into
# somebody's Claude Code / Cursor / Codex config as a side effect of installing
# a CLI is not a reasonable default, however convenient.
WITH_HOOKS=0
for arg in "$@"; do
  case "$arg" in
    --with-hooks) WITH_HOOKS=1 ;;
    -h|--help)
      echo "usage: ./install.sh [--with-hooks]"
      echo "  --with-hooks   also wire the ocd-guard pre-read hook into any of"
      echo "                 Claude Code / Cursor / Codex found on this machine"
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
OPENCODE_CONFIG="$OPENCODE_CONFIG_DIR/opencode.jsonc"
SKILL_DIR="$HOME/.claude/skills/opencode-delegate"
SKILL_FILE="$SKILL_DIR/SKILL.md"
BIN_DIR="$HOME/.local/bin"
STATE_DIR="$HOME/.local/state/ocd"

echo "==> ocd install (repo: $REPO_DIR)"

echo "==> installing dependencies"
(cd "$REPO_DIR" && bun install --silent)

echo "==> ensuring state directories"
mkdir -p "$STATE_DIR/transcripts" "$STATE_DIR/jobs" "$BIN_DIR"

echo "==> merging ocd-delegate agent into $OPENCODE_CONFIG"
mkdir -p "$OPENCODE_CONFIG_DIR"
if [ -f "$OPENCODE_CONFIG" ]; then
  cp "$OPENCODE_CONFIG" "$OPENCODE_CONFIG.bak-$TS"
  echo "    backed up existing config to $OPENCODE_CONFIG.bak-$TS"
fi
bun "$REPO_DIR/install/merge-config.ts" "$OPENCODE_CONFIG" "$REPO_DIR/config/agent.ocd-delegate.jsonc"

echo "==> installing opencode-delegate skill"
mkdir -p "$SKILL_DIR"
if [ -e "$SKILL_FILE" ] && [ ! -L "$SKILL_FILE" ]; then
  cp "$SKILL_FILE" "$SKILL_FILE.bak-$TS"
  echo "    backed up existing skill to $SKILL_FILE.bak-$TS"
fi
rm -f "$SKILL_FILE"
ln -s "$REPO_DIR/skill/SKILL.md" "$SKILL_FILE"
echo "    symlinked $SKILL_FILE -> $REPO_DIR/skill/SKILL.md"

echo "==> symlinking ocd onto PATH"
rm -f "$BIN_DIR/ocd"
ln -s "$REPO_DIR/bin/ocd" "$BIN_DIR/ocd"
echo "    symlinked $BIN_DIR/ocd -> $REPO_DIR/bin/ocd"
rm -f "$BIN_DIR/ocd-guard"
ln -s "$REPO_DIR/bin/ocd-guard" "$BIN_DIR/ocd-guard"
echo "    symlinked $BIN_DIR/ocd-guard -> $REPO_DIR/bin/ocd-guard"

# --- optional: editor hooks -------------------------------------------------
#
# The guard makes delegation automatic rather than dependent on the agent
# choosing to read the skill file: it blocks oversized direct file reads and
# hands back the `ocd run` command to use instead. Every host is wired only if
# its config directory already exists, and every file is backed up first.
if [ "$WITH_HOOKS" = "1" ]; then
  echo "==> wiring ocd-guard hook (--with-hooks)"
  GUARD_BIN="$BIN_DIR/ocd-guard"
  wire_hook() {
    local host="$1" cfg="$2" dir
    dir="$(dirname "$cfg")"
    if [ ! -d "$dir" ]; then
      echo "    skipped $host — $dir not present"
      return 0
    fi
    if [ -f "$cfg" ]; then
      cp "$cfg" "$cfg.bak-$TS"
      echo "    backed up $cfg to $cfg.bak-$TS"
    fi
    bun "$REPO_DIR/install/merge-hooks.ts" "$host" "$cfg" "$GUARD_BIN" | sed 's/^/    /'
  }
  wire_hook claude "$HOME/.claude/settings.json"
  wire_hook cursor "$HOME/.cursor/hooks.json"
  wire_hook codex  "$HOME/.codex/hooks.json"
  echo "    (disable per-session with OCD_GUARD_DISABLE=1; tune with OCD_GUARD_MAX_BYTES)"
else
  echo "==> skipping editor hooks (re-run with --with-hooks to wire ocd-guard into Claude Code / Cursor / Codex)"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "==> $BIN_DIR is already on PATH"
    ;;
  *)
    echo "==> WARNING: $BIN_DIR is not on PATH in this shell. Add it to your shell profile, e.g.:"
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

# Probe the free models once at install time so the health file starts warm.
# Without this the first real task pays to discover that the top-ranked model
# is disabled or geo-blocked — the published metadata cannot distinguish a
# working free model from a dead one, only a live request can.
echo "==> probing free models (this makes a few short free-tier calls)"
bun "$REPO_DIR/src/cli.ts" models --refresh --probe >/dev/null 2>&1 || true
bun "$REPO_DIR/src/cli.ts" models 2>/dev/null | grep -E '"selected"|"variant"' || true

echo "==> running ocd doctor"
bun "$REPO_DIR/src/cli.ts" doctor || {
  echo "==> doctor reported problems above — install completed, but review them before delegating real work."
  exit 1
}

echo "==> install complete"
