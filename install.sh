#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"

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

case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "==> $BIN_DIR is already on PATH"
    ;;
  *)
    echo "==> WARNING: $BIN_DIR is not on PATH in this shell. Add it to your shell profile, e.g.:"
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo "==> running ocd doctor"
bun "$REPO_DIR/src/cli.ts" doctor || {
  echo "==> doctor reported problems above — install completed, but review them before delegating real work."
  exit 1
}

echo "==> install complete"
