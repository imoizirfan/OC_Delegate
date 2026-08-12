#!/usr/bin/env bun
// Merges config/agent.ocd-delegate.jsonc into the live
// ~/.config/opencode/opencode.jsonc under `.agent.ocd-delegate`, leaving
// every other key (including the pre-existing `delegate` agent, mcp
// servers, etc.) untouched. Run via install.sh, never directly — the caller
// is responsible for the pre-write backup.
//
// jq can't parse JSONC (comments), so this does its own conservative
// comment-stripping before JSON.parse. If the live file already has
// comments of its own, this warns rather than silently dropping them,
// since round-tripping comments back out isn't implemented.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const LIVE_PATH = process.argv[2];
const FRAGMENT_PATH = process.argv[3];

if (!LIVE_PATH || !FRAGMENT_PATH) {
  console.error("usage: merge-config.ts <live opencode.jsonc> <agent fragment jsonc>");
  process.exit(1);
}

interface StripResult {
  text: string;
  commentsFound: boolean;
}

function stripJsonComments(text: string): StripResult {
  // Strips // line comments and /* */ block comments while respecting
  // string literals (so a "//" inside a quoted value, e.g. $schema's
  // "https://...", survives and does NOT count as a comment). Good enough
  // for our own authored config files; not a general JSONC parser.
  let out = "";
  let inString = false;
  let stringChar = "";
  let commentsFound = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
        continue;
      }
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      commentsFound = true;
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      commentsFound = true;
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // consume the closing '/'
      continue;
    }
    out += c;
  }
  return { text: out, commentsFound };
}

function loadJsonc(path: string): { value: unknown; commentsFound: boolean } {
  const raw = readFileSync(path, "utf8");
  const { text: stripped, commentsFound } = stripJsonComments(raw);
  // trailing commas are the other common JSONC-ism; drop them too.
  const noTrailingCommas = stripped.replace(/,(\s*[}\]])/g, "$1");
  return { value: JSON.parse(noTrailingCommas), commentsFound };
}

const liveExists = existsSync(LIVE_PATH);
const liveLoaded = liveExists ? loadJsonc(LIVE_PATH) : { value: {}, commentsFound: false };
if (liveLoaded.commentsFound) {
  console.error(
    `warning: ${LIVE_PATH} contains real comments — this merge re-serializes the file as plain JSON, so they will be lost. Review the backup if that matters.`,
  );
}

const live = liveLoaded.value as Record<string, unknown>;
const fragment = loadJsonc(FRAGMENT_PATH).value as Record<string, unknown>;

const ocdAgentConfig = fragment["ocd-delegate"];
if (!ocdAgentConfig) {
  console.error(`fragment ${FRAGMENT_PATH} has no top-level "ocd-delegate" key — nothing to merge`);
  process.exit(1);
}

const existingAgents = (live.agent as Record<string, unknown> | undefined) ?? {};
live.agent = { ...existingAgents, "ocd-delegate": ocdAgentConfig };
if (!live.$schema) live.$schema = "https://opencode.ai/config.json";

writeFileSync(LIVE_PATH, JSON.stringify(live, null, 2) + "\n");
console.log(`merged ocd-delegate agent into ${LIVE_PATH}`);
