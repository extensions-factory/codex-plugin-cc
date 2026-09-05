import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "./fs.mjs";

/**
 * @typedef {{
 *   name: string,
 *   model: string,
 *   effort: string | null,
 *   developerInstructions: string,
 *   fallbackWorker: string | null
 * }} ResolvedWorker
 */

export const WORKERS_DIR = path.resolve(fileURLToPath(new URL("../../workers", import.meta.url)));

const ROSTER_FILENAME = "workers.json";
export const WORKER_KINDS = ["task", "review"];

function rosterPath(workersDir) {
  return path.join(workersDir, ROSTER_FILENAME);
}

/**
 * Reads the worker roster shipped with the plugin.
 * @param {string} [workersDir]
 */
export function loadRoster(workersDir = WORKERS_DIR) {
  const file = rosterPath(workersDir);
  if (!fs.existsSync(file)) {
    throw new Error(`Worker roster not found at ${file}. Reinstall the Codex plugin or restore plugins/codex/workers/.`);
  }

  let roster;
  try {
    roster = readJsonFile(file);
  } catch (error) {
    throw new Error(`Worker roster at ${file} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }

  const workers = roster?.workers;
  if (!workers || typeof workers !== "object" || Array.isArray(workers) || Object.keys(workers).length === 0) {
    throw new Error(`Worker roster at ${file} defines no workers.`);
  }

  const defaults = roster.defaults;
  const known = Object.keys(workers).sort().join(", ");
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new Error(`Worker roster at ${file} has no "defaults" map. Map each kind (task, review) to one of: ${known}.`);
  }
  for (const kind of WORKER_KINDS) {
    if (typeof defaults[kind] !== "string" || !workers[defaults[kind]]) {
      throw new Error(`Worker roster at ${file} has no valid default for "${kind}". Set "defaults.${kind}" to one of: ${known}.`);
    }
  }

  return { defaults, workers, workersDir };
}

/**
 * Lists roster entries for discovery output.
 * @param {ReturnType<typeof loadRoster>} roster
 */
export function listWorkers(roster) {
  return Object.entries(roster.workers)
    .map(([name, profile]) => ({
      name,
      model: typeof profile?.model === "string" ? profile.model : null,
      effort: typeof profile?.effort === "string" ? profile.effort : null,
      description: typeof profile?.description === "string" ? profile.description : "",
      defaultFor: WORKER_KINDS.filter((kind) => roster.defaults[kind] === name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readInstructions(roster, name, profile) {
  const instructionsFile = profile?.instructionsFile;
  if (typeof instructionsFile !== "string" || !instructionsFile.trim()) {
    throw new Error(`Worker "${name}" has no "instructionsFile".`);
  }

  const resolved = path.resolve(roster.workersDir, instructionsFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Worker "${name}" points at missing instructions file ${resolved}.`);
  }

  const instructions = fs.readFileSync(resolved, "utf8").trim();
  if (!instructions) {
    throw new Error(`Worker "${name}" has an empty instructions file at ${resolved}.`);
  }
  return instructions;
}

/**
 * Resolves the worker a run should use.
 * `worker` selects a profile, otherwise the roster default for `kind` applies;
 * `model`/`effort` override that profile's values.
 * `fallbackWorker` is the profile's stand-in for a usage-limited run. An explicit
 * `model` override drops it: the caller picked that model on purpose.
 * @param {{ worker?: string | null, model?: string | null, effort?: string | null, kind?: "task" | "review" }} [request]
 * @param {ReturnType<typeof loadRoster>} [roster]
 * @returns {ResolvedWorker}
 */
export function resolveWorker(request = {}, roster = loadRoster()) {
  const kind = request.kind ?? "task";
  if (!WORKER_KINDS.includes(kind)) {
    throw new Error(`Unknown worker kind "${kind}".`);
  }
  const requestedName = typeof request.worker === "string" ? request.worker.trim() : "";
  const name = requestedName || roster.defaults[kind];
  const profile = roster.workers[name];

  if (!profile) {
    throw new Error(
      `Unknown worker "${requestedName}". Available workers: ${Object.keys(roster.workers).sort().join(", ")}.`
    );
  }

  const modelOverride = typeof request.model === "string" && request.model.trim();
  const model = modelOverride || profile.model;
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(`Worker "${name}" has no model. Set "model" in the roster or pass --model.`);
  }

  const effort =
    (typeof request.effort === "string" && request.effort.trim()) ||
    (typeof profile.effort === "string" && profile.effort.trim()) ||
    null;

  const fallbackWorker =
    !modelOverride && typeof profile.fallbackWorker === "string" && profile.fallbackWorker.trim()
      ? profile.fallbackWorker.trim()
      : null;
  if (fallbackWorker && !roster.workers[fallbackWorker]) {
    throw new Error(
      `Worker "${name}" names an unknown fallbackWorker "${fallbackWorker}". Available workers: ${Object.keys(roster.workers).sort().join(", ")}.`
    );
  }

  return {
    name,
    model: model.trim(),
    effort,
    developerInstructions: readInstructions(roster, name, profile),
    fallbackWorker
  };
}

// Claude reaches the roster through a `--worker` flag it has to know exists. Left to
// the agent description alone it defaults to one worker and the other ten stay unused,
// so the hooks inject the roster instead of waiting to be asked for it.
const DELEGATION_COMMAND = "/codex:rescue --worker <name>";

/**
 * Full roster table, injected once per session by the SessionStart hook.
 *
 * @param {ReturnType<typeof loadRoster>} [roster]
 * @returns {string}
 */
export function formatRosterHint(roster = loadRoster()) {
  const lines = listWorkers(roster).map((worker) => {
    const defaultFor = worker.defaultFor.length > 0 ? ` (default for ${worker.defaultFor.join(", ")})` : "";
    return `  ${worker.name}${defaultFor} — ${worker.description}`;
  });

  return [
    `Codex worker roster — delegate with \`${DELEGATION_COMMAND} <task>\`, or through the codex-rescue subagent:`,
    ...lines,
    "Pick the worker whose role matches the task instead of accepting the default.",
    "Do not delegate work the main thread finishes quickly; delegation is for substantial or second-opinion work."
  ].join("\n");
}

/**
 * One-line reminder, injected per prompt by the UserPromptSubmit hook. The full table
 * from SessionStart drifts out of reach in a long session; the names alone are enough
 * to pick from and cheap enough to repeat.
 *
 * @param {ReturnType<typeof loadRoster>} [roster]
 * @returns {string}
 */
export function formatRosterReminder(roster = loadRoster()) {
  const names = listWorkers(roster).map((worker) => worker.name);
  return `Codex workers available (\`${DELEGATION_COMMAND}\`): ${names.join(", ")}.`;
}
