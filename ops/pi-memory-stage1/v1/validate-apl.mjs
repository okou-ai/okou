import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import fixtures from "./query-fixtures.mjs";

// Explicit, read-only service validation. No ingestion, monitor API or retries.
const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    output: { type: "string" },
  },
});
assert.ok(
  ["production", "fixtures"].includes(values.mode),
  "--mode production|fixtures",
);
assert.ok(values.output, "--output must name a new receipt directory");
assert.ok(
  process.env.AXIOM_TOKEN,
  "AXIOM_TOKEN must be supplied by the query connector",
);
const start = Date.parse(values.start);
const end = Date.parse(values.end);
assert.ok(
  typeof values.start === "string" &&
    typeof values.end === "string" &&
    values.start.endsWith("Z") &&
    values.end.endsWith("Z") &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start &&
    end - start <= 300000,
  "Supply an explicit UTC --start/--end window of at most five minutes",
);
await mkdir(values.output); // Do not overwrite previous evidence.
const endpoint = "https://api.axiom.co/v1/datasets/_apl?format=tabular";
const config = JSON.parse(
  await readFile(new URL("definitions.json", import.meta.url), "utf8"),
);
const queries = await Promise.all(
  config.monitors.map(async ({ queryFile, definition, groupField }) => ({
    queryFile,
    definition,
    groupField,
    apl: await readFile(new URL(queryFile, import.meta.url), "utf8"),
  })),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const summary = {
  endpoint,
  mode: values.mode,
  requestWindow: { startTime: values.start, endTime: values.end },
  startedAt: new Date().toISOString(),
  sourceQueries: Object.fromEntries(
    queries.map(({ queryFile, apl }) => [queryFile, hash(apl)]),
  ),
  results: [],
};
function tableRows(response) {
  return response.tables.flatMap((table) =>
    Array.from({ length: table.columns[0]?.length ?? 0 }, (_, index) =>
      Object.fromEntries(
        table.fields.map((field, column) => [
          field.name,
          table.columns[column][index],
        ]),
      ),
    ),
  );
}
async function execute(label, apl, groupField, columnName) {
  const request = { apl, startTime: values.start, endTime: values.end };
  const requestedAt = new Date().toISOString();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AXIOM_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(45000),
  });
  const body = await response.json();
  const receipt = {
    label,
    requestedAt,
    request,
    httpStatus: response.status,
    response: body,
  };
  await writeFile(
    `${values.output}/${label}.json`,
    JSON.stringify(receipt, null, 2) + "\n",
  );
  const result = {
    label,
    requestSha256: hash(JSON.stringify(request)),
    httpStatus: response.status,
    isPartial: body.status?.isPartial,
    datasetNames: body.datasetNames,
    rows: body.tables ? tableRows(body) : undefined,
    messages: body.status?.messages,
    groups: body.tables?.[0]?.groups,
    valueAggregation: body.tables?.[0]?.fields.find(
      (field) => field.name === columnName,
    )?.agg,
  };
  summary.results.push(result);
  await writeFile(
    `${values.output}/summary.json`,
    JSON.stringify(summary, null, 2) + "\n",
  );
  assert.equal(response.status, 200, `${label}: ${JSON.stringify(body)}`);
  assert.equal(body.status.isPartial, false, `${label}: partial query results`);
  if (values.mode === "fixtures")
    assert.deepEqual(
      body.datasetNames,
      [],
      "Fixtures must never read a live dataset",
    );
  assert.equal(body.tables.length, 1, `${label}: one monitor result table`);
  assert.deepEqual(
    body.tables[0].groups,
    [{ name: groupField }],
    `${label}: monitor grouping metadata`,
  );
  assert.ok(
    result.valueAggregation,
    `${label}: monitor value aggregation metadata`,
  );
  console.log(`${label}: HTTP 200, non-partial, grouped aggregate`);
  return result.rows;
}
function bindFixture(apl, fixture) {
  const source = "['vm0-web-logs-prod']";
  assert.equal(
    apl.split(source).length,
    2,
    "Exactly one production dataset binding is required",
  );
  assert.match(fixture.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  assert.ok(Number.isFinite(Date.parse(fixture.now)));
  const fieldNames = [
    ...new Set(fixture.events.flatMap((row) => Object.keys(row.fields))),
  ].sort();
  assert.ok(fieldNames.every((field) => /^[A-Za-z][A-Za-z0-9]*$/.test(field)));
  // Use transport scalar types, including typed null (dynamic(null) differs in APL).
  const declaredTypes = new Map(
    [...apl.matchAll(/ensure_field\('fields\.(\w+)', typeof\((\w+)\)\)/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
  const types = fieldNames.map((field) => {
    const value = fixture.events
      .map((row) => row.fields[field])
      .find((value) => value != null);
    return value == null
      ? (declaredTypes.get(field) ?? "string")
      : typeof value === "number"
        ? "real"
        : "string";
  });
  const columns = [
    "dataset:string",
    "_time:datetime",
    "source:string",
    "level:string",
    ...fieldNames.map((field, index) => `['fields.${field}']:${types[index]}`),
  ];
  const cells = fixture.events.flatMap((row) => [
    JSON.stringify(row.dataset),
    `datetime(${row._time})`,
    JSON.stringify(row.source),
    JSON.stringify(row.level),
    ...fieldNames.map((field, index) =>
      row.fields[field] == null
        ? `${types[index]}(null)`
        : JSON.stringify(row.fields[field]),
    ),
  ]);
  const prefix =
    `let fixtureRows = datatable(${columns.join(", ")})[${cells.join(", ")}];\n` +
    `let fixtureSource = fixtureRows | where dataset == 'vm0-web-logs-prod';\n`;
  // Only the input table and clock change. Every committed query operator runs.
  return (
    prefix +
    apl
      .replace(source, "fixtureSource")
      .replaceAll("now()", `datetime(${fixture.now})`)
  );
}
if (values.mode === "production") {
  for (const { queryFile, apl, groupField, definition } of queries)
    await execute(queryFile, apl, groupField, definition.columnName);
  summary.interpretation =
    "Bounded parser/query receipt only. Empty cost or zero health is expected inactivity while all off; ingestion completeness and monitor delivery remain unproven.";
} else {
  const text = await readFile(
    new URL("fixtures.json", import.meta.url),
    "utf8",
  );
  summary.fixtureSha256 = hash(text);
  summary.fixtureGeneratorSha256 = hash(
    await readFile(new URL("query-fixtures.mjs", import.meta.url), "utf8"),
  );
  for (const [index, fixture] of fixtures.entries()) {
    for (const { queryFile, apl, definition, groupField } of queries) {
      const rows = await execute(
        `${String(index).padStart(2, "0")}-${queryFile}`,
        bindFixture(apl, fixture),
        groupField,
        definition.columnName,
      );
      if (queryFile === "cost.apl")
        assert.deepEqual(
          rows
            .map((row) => ({
              day: row.accountingDay,
              total: row.grossCreditValueUsd,
              breached: row.grossCreditValueUsd >= definition.threshold,
            }))
            .sort((a, b) => a.day.localeCompare(b.day)),
          fixture.expected.days,
          fixture.name,
        );
      else {
        assert.equal(
          rows.some((row) => row.healthProblemCount >= definition.threshold),
          fixture.expected.healthProblem,
          fixture.name,
        );
        for (const row of rows)
          assert.match(row.incidentDay, /^\d{4}-\d{2}-\d{2}$/, fixture.name);
        if (fixture.expected.healthDays)
          assert.deepEqual(
            rows
              .filter((row) => row.healthProblemCount >= definition.threshold)
              .map((row) => row.incidentDay)
              .sort(),
            fixture.expected.healthDays,
            fixture.name,
          );
      }
    }
    summary.results.at(-1).fixture = fixture.name;
    summary.results.at(-1).assertionsPassed = true;
  }
}
summary.completedAt = new Date().toISOString();
await writeFile(
  `${values.output}/summary.json`,
  JSON.stringify(summary, null, 2) + "\n",
);
