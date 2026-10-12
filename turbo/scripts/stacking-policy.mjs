import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

import {
  collectStackingDeclarations,
  isStackingSource,
} from "./stacking-source.mjs";

const REGISTRY = "stacking-ownership.json";
const fields = [
  "file",
  "scope",
  "kind",
  "value",
  "count",
  "owner",
  "host",
  "rationale",
  "status",
  "evidence",
];

function key(record) {
  return JSON.stringify([record.file, record.scope, record.kind, record.value]);
}

function validateRegistry(registry) {
  if (registry?.version !== 1 || !Array.isArray(registry.entries)) {
    throw new Error(`${REGISTRY} must contain version 1 and an entries array.`);
  }
  const keys = new Set();
  for (const [index, entry] of registry.entries.entries()) {
    const invalid =
      !entry ||
      Object.keys(entry).some((field) => !fields.includes(field)) ||
      fields
        .filter((field) => field !== "count")
        .some(
          (field) => typeof entry[field] !== "string" || !entry[field].trim(),
        ) ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 1 ||
      !["utility", "style", "css"].includes(entry.kind) ||
      !["verified", "audit-pending"].includes(entry.status) ||
      !isStackingSource(entry.file) ||
      posix.normalize(entry.file) !== entry.file ||
      /[\\*?{}]/.test(entry.file);
    if (invalid)
      throw new Error(
        `${REGISTRY} entries[${index}] must name an exact production file, source scope, declaration, positive count, owner, host, rationale, status (verified or audit-pending), and evidence.`,
      );
    if (keys.has(key(entry)))
      throw new Error(
        `${REGISTRY} entries[${index}] duplicates an ownership entry.`,
      );
    keys.add(key(entry));
  }
}

export function checkStackingPolicy(root) {
  const issues = [];
  let registry;
  try {
    registry = JSON.parse(readFileSync(join(root, REGISTRY), "utf8"));
    validateRegistry(registry);
  } catch (error) {
    return [
      {
        type: "stacking-configuration",
        file: REGISTRY,
        line: 1,
        message: error.message,
      },
    ];
  }
  const actual = new Map();
  for (const record of collectStackingDeclarations(root)) {
    if (record.kind === "dynamic") {
      issues.push({
        ...record,
        type: "stacking-dynamic",
        message:
          "Use complete literal z-index utilities and CSS declarations. Dynamically constructed layers cannot be registered.",
      });
      continue;
    }
    const existing = actual.get(key(record));
    if (existing) existing.count += 1;
    else actual.set(key(record), { ...record, count: 1 });
  }
  const expected = new Map(
    registry.entries.map((entry) => [key(entry), entry]),
  );
  for (const id of new Set([...actual.keys(), ...expected.keys()])) {
    const found = actual.get(id);
    const entry = expected.get(id);
    if ((found?.count ?? 0) === (entry?.count ?? 0)) continue;
    const record = found ?? entry;
    const stale = (found?.count ?? 0) < (entry?.count ?? 0);
    issues.push({
      file: record.file,
      line: found?.line ?? 1,
      type: stale ? "stacking-stale" : "stacking-ownership",
      message: `${record.scope}: ${record.kind} \`${record.value}\` has ${found?.count ?? 0} declarations; ${REGISTRY} records ${entry?.count ?? 0}. ${stale ? "Remove or reduce the stale entry." : "Remove the business-control layer or document its exact owner, host, ordering rationale, and evidence for review."}`,
    });
  }
  return issues;
}
