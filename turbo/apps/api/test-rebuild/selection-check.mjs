import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const directory = import.meta.dirname;
const prefix = "turbo/apps/api/";
const baseline = JSON.parse(
  readFileSync(resolve(directory, "baseline.json"), "utf8"),
);
const readTsv = (name) => {
  const [header, ...lines] = readFileSync(resolve(directory, name), "utf8")
    .split("\n")
    .filter(Boolean);
  const columns = header.split("\t");
  return lines.map((line) => {
    const values = line.split("\t");
    if (values.length !== columns.length) {
      throw new Error(`${name}: expected ${columns.length} columns: ${line}`);
    }
    return Object.fromEntries(
      columns.map((column, i) => {
        return [column, values[i]];
      }),
    );
  });
};

const bases = new Set([
  "core-path",
  "visible-result",
  "business-rule",
  "access-isolation",
]);
const decisions = new Map();
for (const row of readTsv("selection.tsv")) {
  if (decisions.has(row.case_id)) {
    throw new Error(`Duplicate decision for ${row.case_id}`);
  }
  if (row.decision === "selected" && !bases.has(row.basis)) {
    throw new Error(`${row.case_id}: selected case needs a basis`);
  }
  if (row.decision === "not-selected" && row.basis) {
    throw new Error(`${row.case_id}: not-selected case has a basis`);
  }
  if (row.decision !== "selected" && row.decision !== "not-selected") {
    throw new Error(`${row.case_id}: unknown decision ${row.decision}`);
  }
  decisions.set(row.case_id, row);
}

const files = new Map(
  readTsv("selection-files.tsv").map((row) => {
    return [row.test_file, row];
  }),
);
let cases = 0;
let selected = 0;
const exceptions = { more: 0, fewer: 0 };
for (const { file, cases: frozen } of baseline.files) {
  const testFile = file.slice(prefix.length);
  const ledger = files.get(testFile);
  if (!ledger) {
    throw new Error(`Missing file ledger for ${testFile}`);
  }
  files.delete(testFile);
  let fileSelected = 0;
  for (const { id } of frozen) {
    const row = decisions.get(id);
    if (!row) {
      throw new Error(`Missing decision for ${id}`);
    }
    if (row.test_file !== testFile) {
      throw new Error(`${id}: recorded under ${row.test_file}`);
    }
    decisions.delete(id);
    if (row.decision === "selected") {
      fileSelected += 1;
    }
  }
  const quota = Math.ceil(frozen.length / 2);
  const expected = [frozen.length, quota, fileSelected].map(String);
  const recorded = [ledger.cases, ledger.quota, ledger.selected];
  if (expected.join("/") !== recorded.join("/")) {
    throw new Error(`${testFile}: counts ${recorded} differ from ${expected}`);
  }
  const kind =
    fileSelected > quota ? "more" : fileSelected < quota ? "fewer" : "none";
  if (ledger.exception !== kind || (kind !== "none") !== !!ledger.reason) {
    throw new Error(`${testFile}: exception must be ${kind} with a reason`);
  }
  if (kind !== "none") {
    exceptions[kind] += 1;
  }
  cases += frozen.length;
  selected += fileSelected;
}
if (decisions.size || files.size) {
  throw new Error(
    `Unknown entries: ${[...decisions.keys(), ...files.keys()].join(", ")}`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    baseline: baseline.baseline,
    files: baseline.files.length,
    cases,
    selected,
    notSelected: cases - selected,
    selectedPercent: Number(((selected / cases) * 100).toFixed(1)),
    exceptionFiles: exceptions.more + exceptions.fewer,
    ...exceptions,
  })}\n`,
);
