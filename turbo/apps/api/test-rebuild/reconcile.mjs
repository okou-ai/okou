import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";

const directory = import.meta.dirname;
const repo = resolve(directory, "../../../..");
const partial = process.argv.includes("--partial");
const baseline = JSON.parse(
  readFileSync(resolve(directory, "baseline.json"), "utf8"),
);
const expected = new Map();
const ids = new Set();

for (const { file, cases } of baseline.files) {
  const bdd = file.replace(/\.(test|spec)\.[^.]+$/u, ".bdd.md");
  if (file === bdd || expected.has(bdd)) {
    throw new Error(`Conflicting BDD path for ${file}`);
  }
  for (const test of cases) {
    if (ids.has(test.id)) {
      throw new Error(`Duplicate baseline ID ${test.id}`);
    }
    ids.add(test.id);
  }
  expected.set(bdd, { file, cases });
}

const api = resolve(repo, "turbo/apps/api");
function findBddFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (
      entry.isDirectory() &&
      !["node_modules", "dist", ".typecheck"].includes(entry.name)
    ) {
      return findBddFiles(path);
    }
    if (entry.isFile() && entry.name.endsWith(".bdd.md")) {
      return [relative(repo, path)];
    }
    return [];
  });
}

const documents = findBddFiles(api);

for (const document of documents) {
  if (!expected.has(document)) {
    throw new Error(`BDD document has no baseline file: ${document}`);
  }
}

const rows = ["test_file\tcase_id\tmode\tbdd_file\tstatus"];
let written = 0;
let completeFiles = 0;
let review = 0;
let missing = 0;
const present = new Set(documents);

// A frozen file is settled once every selected ID in rewrite.tsv is rewritten or
// skipped. Its temporary BDD is then removed; the frozen text stays in history.
const pilotStatuses = new Map();
const [, ...pilotLines] = readFileSync(
  resolve(directory, "rewrite.tsv"),
  "utf8",
)
  .split("\n")
  .filter(Boolean);
for (const line of pilotLines) {
  const [, testFile, , status] = line.split("\t");
  const file = `turbo/apps/api/${testFile}`;
  pilotStatuses.set(file, [...(pilotStatuses.get(file) ?? []), status]);
}
const settledFiles = new Set(
  [...pilotStatuses]
    .filter(([, statuses]) => {
      return statuses.every((status) => {
        return status === "rewritten" || status === "skipped";
      });
    })
    .map(([file]) => {
      return file;
    }),
);
let settled = 0;
let settledFileCount = 0;

for (const [bdd, { file, cases }] of expected) {
  if (!present.has(bdd) && settledFiles.has(file)) {
    for (const test of cases) {
      rows.push([file, test.id, test.mode, bdd, "settled"].join("\t"));
    }
    settled += cases.length;
    settledFileCount += 1;
    completeFiles += 1;
    continue;
  }
  const blocks = present.has(bdd)
    ? readFileSync(resolve(repo, bdd), "utf8").split(/^## /mu).slice(1)
    : [];
  const entries = new Map();
  for (const block of blocks) {
    const [id, ...lines] = block.split(/\r?\n/u);
    if (entries.has(id)) {
      throw new Error(`Duplicate BDD ID ${id} in ${bdd}`);
    }
    entries.set(id, lines);
  }

  const missingBeforeFile = missing;
  for (const test of cases) {
    const field = (label) => {
      const prefix = `- ${label}: `;
      const values = entries
        .get(test.id)
        .filter((line) => {
          return line.startsWith(prefix);
        })
        .map((line) => {
          return line.slice(prefix.length);
        });
      if (values.length !== 1 || !values[0].trim()) {
        throw new Error(`Expected one populated ${label} field for ${test.id}`);
      }
      return values[0];
    };
    let status = "missing";
    if (entries.has(test.id)) {
      const name = JSON.parse(field("Vitest"));
      const mode = field("Mode");
      if (name !== test.name || mode !== test.mode) {
        throw new Error(
          `${test.id}: expected ${JSON.stringify([test.name, test.mode])}, found ${JSON.stringify([name, mode])}`,
        );
      }
      for (const label of ["Given", "When", "Then"]) {
        field(label);
      }
      if (entries.get(test.id).includes("- Intent: review")) {
        status = "review";
        review += 1;
      } else {
        status = "written";
      }
      written += 1;
      entries.delete(test.id);
    } else {
      missing += 1;
    }
    rows.push([file, test.id, test.mode, bdd, status].join("\t"));
  }

  if (missing === missingBeforeFile) {
    completeFiles += 1;
  }
  if (entries.size) {
    throw new Error(
      `Unmatched BDD IDs in ${bdd}: ${[...entries.keys()].join(", ")}`,
    );
  }
}

if (missing && !partial) {
  throw new Error(`Missing ${missing} of ${ids.size} BDD scenarios`);
}
writeFileSync(resolve(directory, "reconciliation.tsv"), rows.join("\n") + "\n");
process.stdout.write(
  `${JSON.stringify({
    baseline: baseline.baseline,
    files: expected.size,
    cases: ids.size,
    writtenFiles: present.size,
    completeFiles,
    settledFiles: settledFileCount,
    settled,
    written,
    review,
    missing,
  })}\n`,
);
