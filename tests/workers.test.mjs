import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  formatRosterHint,
  formatRosterReminder,
  listWorkers,
  loadRoster,
  resolveWorker,
  WORKERS_DIR
} from "../plugins/codex/scripts/lib/workers.mjs";

function writeRoster(roster, files = {}) {
  const dir = makeTempDir("codex-workers-");
  fs.writeFileSync(path.join(dir, "workers.json"), JSON.stringify(roster, null, 2), "utf8");
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

function sampleRoster() {
  return writeRoster(
    {
      defaults: { task: "implementer", review: "reviewer" },
      workers: {
        implementer: {
          model: "cx/test-implementer",
          effort: "medium",
          description: "Writes code.",
          instructionsFile: "implementer.md"
        },
        reviewer: {
          model: "cx/test-reviewer",
          effort: "high",
          description: "Reviews code.",
          instructionsFile: "reviewer.md"
        }
      }
    },
    {
      "implementer.md": "Implementer soul.\n",
      "reviewer.md": "Reviewer soul.\n"
    }
  );
}

test("resolveWorker falls back to the default worker for the kind", () => {
  const roster = loadRoster(sampleRoster());

  const task = resolveWorker({}, roster);
  assert.equal(task.name, "implementer");
  assert.equal(task.model, "cx/test-implementer");
  assert.equal(task.effort, "medium");
  assert.equal(task.developerInstructions, "Implementer soul.");

  const review = resolveWorker({ kind: "review" }, roster);
  assert.equal(review.name, "reviewer");
  assert.equal(review.developerInstructions, "Reviewer soul.");
});

test("resolveWorker selects a named worker regardless of kind", () => {
  const roster = loadRoster(sampleRoster());
  const resolved = resolveWorker({ worker: "reviewer", kind: "task" }, roster);

  assert.equal(resolved.name, "reviewer");
  assert.equal(resolved.model, "cx/test-reviewer");
  assert.equal(resolved.effort, "high");
  assert.equal(resolved.developerInstructions, "Reviewer soul.");
});

test("resolveWorker lets explicit model and effort override the profile", () => {
  const roster = loadRoster(sampleRoster());
  const resolved = resolveWorker({ worker: "reviewer", model: "cx/override", effort: "low" }, roster);

  assert.equal(resolved.model, "cx/override");
  assert.equal(resolved.effort, "low");
  assert.equal(resolved.developerInstructions, "Reviewer soul.");
});

test("resolveWorker rejects an unknown worker and lists the roster", () => {
  const roster = loadRoster(sampleRoster());

  assert.throws(() => resolveWorker({ worker: "nope" }, roster), /Unknown worker "nope".*implementer, reviewer/s);
});

test("resolveWorker rejects an unknown kind", () => {
  const roster = loadRoster(sampleRoster());

  assert.throws(() => resolveWorker({ kind: "deploy" }, roster), /Unknown worker kind "deploy"/);
});

test("resolveWorker rejects a worker whose instructions file is missing", () => {
  const dir = writeRoster({
    defaults: { task: "ghost", review: "ghost" },
    workers: {
      ghost: { model: "cx/test", description: "", instructionsFile: "ghost.md" }
    }
  });

  assert.throws(() => resolveWorker({}, loadRoster(dir)), /missing instructions file/);
});

test("loadRoster rejects a roster whose default for a kind is not defined", () => {
  const dir = writeRoster({
    defaults: { task: "implementer", review: "absent" },
    workers: {
      implementer: { model: "cx/test", instructionsFile: "implementer.md" }
    }
  });

  assert.throws(() => loadRoster(dir), /no valid default for "review".*implementer/s);
});

test("listWorkers reports every worker and which kinds it is the default for", () => {
  const roster = loadRoster(sampleRoster());
  const workers = listWorkers(roster);

  assert.deepEqual(
    workers.map((worker) => worker.name),
    ["implementer", "reviewer"]
  );
  assert.deepEqual(workers.find((worker) => worker.name === "implementer")?.defaultFor, ["task"]);
  assert.deepEqual(workers.find((worker) => worker.name === "reviewer")?.defaultFor, ["review"]);
});

test("the shipped roster resolves every worker it declares", () => {
  const roster = loadRoster(WORKERS_DIR);

  for (const worker of listWorkers(roster)) {
    const resolved = resolveWorker({ worker: worker.name }, roster);
    assert.equal(resolved.name, worker.name);
    assert.ok(resolved.model.length > 0, `${worker.name} has a model`);
    assert.ok(resolved.developerInstructions.length > 0, `${worker.name} has instructions`);
    assert.ok(worker.description.length > 0, `${worker.name} has a description`);
  }
});

test("resolveWorker reports a profile's fallback worker", () => {
  const dir = writeRoster(
    {
      defaults: { task: "implementer", review: "reviewer" },
      workers: {
        implementer: { model: "cx/primary", instructionsFile: "implementer.md", fallbackWorker: "backup" },
        backup: { model: "cx/backup", instructionsFile: "implementer.md" },
        reviewer: { model: "cx/reviewer", instructionsFile: "implementer.md" }
      }
    },
    { "implementer.md": "Implementer soul.\n" }
  );
  const roster = loadRoster(dir);

  assert.equal(resolveWorker({}, roster).fallbackWorker, "backup");
  assert.equal(resolveWorker({ worker: "backup" }, roster).fallbackWorker, null);
});

test("an explicit model override drops the fallback worker", () => {
  const dir = writeRoster(
    {
      defaults: { task: "implementer", review: "reviewer" },
      workers: {
        implementer: { model: "cx/primary", instructionsFile: "implementer.md", fallbackWorker: "backup" },
        backup: { model: "cx/backup", instructionsFile: "implementer.md" },
        reviewer: { model: "cx/reviewer", instructionsFile: "implementer.md" }
      }
    },
    { "implementer.md": "Implementer soul.\n" }
  );
  const roster = loadRoster(dir);

  const resolved = resolveWorker({ model: "cx/override" }, roster);
  assert.equal(resolved.model, "cx/override");
  assert.equal(resolved.fallbackWorker, null);
});

test("an unknown fallback worker is rejected", () => {
  const dir = writeRoster(
    {
      defaults: { task: "implementer", review: "reviewer" },
      workers: {
        implementer: { model: "cx/primary", instructionsFile: "implementer.md", fallbackWorker: "ghost" },
        reviewer: { model: "cx/reviewer", instructionsFile: "implementer.md" }
      }
    },
    { "implementer.md": "Implementer soul.\n" }
  );
  const roster = loadRoster(dir);

  assert.throws(() => resolveWorker({}, roster), /unknown fallbackWorker "ghost"/);
});

test("the roster hint names every worker, its role, and the delegation command", () => {
  const roster = loadRoster();
  const hint = formatRosterHint(roster);

  for (const worker of listWorkers(roster)) {
    assert.match(hint, new RegExp(`\\b${worker.name}\\b`), `hint is missing ${worker.name}`);
    assert.ok(hint.includes(worker.description), `hint is missing the description for ${worker.name}`);
  }

  assert.match(hint, /--worker <name>/);
  assert.match(hint, /\(default for task\)/);
  assert.match(hint, /\(default for review\)/);
  assert.match(hint, /Do not delegate work the main thread finishes quickly/);
});

test("the roster reminder lists every worker name on one line", () => {
  const roster = loadRoster();
  const reminder = formatRosterReminder(roster);

  assert.equal(reminder.split("\n").length, 1);
  for (const worker of listWorkers(roster)) {
    assert.match(reminder, new RegExp(`\\b${worker.name}\\b`), `reminder is missing ${worker.name}`);
  }
  assert.match(reminder, /--worker <name>/);
});
