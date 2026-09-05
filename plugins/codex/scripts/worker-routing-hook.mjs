#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { formatRosterReminder } from "./lib/workers.mjs";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

// The SessionStart hook prints the full roster once, which drifts out of reach in a long
// session. This reminder rides along with every prompt so the worker names stay next to
// the request that might need them. `additionalContext` must be nested inside
// `hookSpecificOutput`; at the top level Claude Code silently ignores it.
function main() {
  const reminder = formatRosterReminder();
  if (!reminder) {
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: reminder
      }
    })}\n`
  );
}

try {
  readHookInput();
  main();
} catch {
  // A prompt must never fail because the roster could not be read.
}
