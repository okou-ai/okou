import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Independent fixture oracle for the documented query contract, NOT an APL
// interpreter. Live parser, query and monitor behavior are separate gates.
const fixtures = JSON.parse(
  await readFile(new URL("fixtures.json", import.meta.url), "utf8"),
);
function validNano(value) {
  return (
    typeof value === "string" &&
    /^\d+$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function evaluate(rows, now) {
  const start = Date.parse(`${now.slice(0, 10)}T00:00:00Z`);
  const dayMs = 86400000;
  const observations = rows.filter(
    (row) =>
      row.dataset === "vm0-web-logs-prod" &&
      row.source === "api" &&
      row.level === "info" &&
      row.fields.context === "PiMemoryStage1Cost" &&
      row.fields.operation === "pi_memory_stage1" &&
      row.fields.billingMode !== "byok" &&
      Date.parse(row._time) >= start - 2 * dayMs &&
      Date.parse(row._time) < Date.parse(now),
  );
  const byId = new Map();
  let healthProblem = false;
  for (const row of observations) {
    const f = row.fields;
    const zero = f.ledgerStatus === "zero_usage";
    if (
      f.billingMode !== "builtin" ||
      f.costVersion !== 1 ||
      ![
        "new",
        "replay",
        "legacy_replay",
        "zero_usage",
        "persistence_error",
        "not_recorded",
      ].includes(f.ledgerStatus) ||
      [
        f.inputTokens,
        f.outputTokens,
        f.cacheReadTokens,
        f.cacheCreationTokens,
      ].some((q) => !Number.isSafeInteger(q) || q < 0) ||
      f.usageStatus !== "valid" ||
      ["persistence_error", "legacy_replay", "not_recorded"].includes(
        f.ledgerStatus,
      ) ||
      (zero &&
        [
          f.inputTokens,
          f.outputTokens,
          f.cacheReadTokens,
          f.cacheCreationTokens,
        ].some((q) => q !== 0)) ||
      (["replay", "zero_usage"].includes(f.ledgerStatus) &&
        (f.pricingStatus !== f.ledgerStatus ||
          f.grossCreditValueUsd != null ||
          f.grossCreditValueNanoUsd != null)) ||
      (!zero &&
        (!f.accountingId ||
          !Number.isFinite(Date.parse(f.accountingAt)) ||
          !Number.isFinite(Date.parse(f.observedAt)))) ||
      f.currency !== "USD" ||
      f.unit !== "gross_credit_value" ||
      f.creditsPerUsd !== 1000 ||
      (f.ledgerStatus === "new" &&
        (f.pricingStatus !== "available" ||
          !Number.isFinite(f.grossCreditValueUsd) ||
          f.grossCreditValueUsd < 0 ||
          !f.priceBasis ||
          !validNano(f.grossCreditValueNanoUsd)))
    )
      healthProblem = true;
    if (f.accountingId && ["new", "replay"].includes(f.ledgerStatus)) {
      const group = byId.get(f.accountingId) ?? [];
      group.push(f);
      byId.set(f.accountingId, group);
    }
  }
  const totals = new Map();
  const order = (f) =>
    [
      f.observedAt,
      f.pricingStatus,
      f.priceBasis ?? "",
      f.grossCreditValueUsd ?? "",
      f.grossCreditValueNanoUsd ?? "",
    ].join("|");
  for (const group of byId.values()) {
    const originals = group.filter(
      (f) =>
        f.billingMode === "builtin" &&
        f.ledgerStatus === "new" &&
        f.costVersion === 1,
    );
    if (originals.length === 0) healthProblem = true;
    const identities = new Set(
      group.map((f) =>
        JSON.stringify([
          f.accountingAt,
          f.model,
          f.inputTokens,
          f.outputTokens,
          f.cacheReadTokens,
          f.cacheCreationTokens,
        ]),
      ),
    );
    const bases = new Set(
      originals.map((f) =>
        JSON.stringify([
          f.priceBasis,
          f.pricingStatus,
          f.grossCreditValueUsd,
          f.grossCreditValueNanoUsd,
        ]),
      ),
    );
    if (identities.size > 1 || bases.size > 1) healthProblem = true;
    originals.sort((a, b) =>
      order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0,
    );
    const f = originals[0];
    if (!f || !Number.isFinite(Date.parse(f.observedAt))) continue;
    const at = Date.parse(f.accountingAt);
    if (
      !(at >= start - dayMs && at < start + dayMs) ||
      f.usageStatus !== "valid" ||
      f.pricingStatus !== "available" ||
      f.currency !== "USD" ||
      f.unit !== "gross_credit_value" ||
      f.creditsPerUsd !== 1000 ||
      !Number.isFinite(f.grossCreditValueUsd) ||
      f.grossCreditValueUsd < 0
    )
      continue;
    const day = f.accountingAt.slice(0, 10);
    if (!validNano(f.grossCreditValueNanoUsd)) continue;
    totals.set(
      day,
      (totals.get(day) ?? 0n) + BigInt(f.grossCreditValueNanoUsd),
    );
  }
  return {
    days: [...totals].sort().map(([day, nano]) => ({
      day,
      total: Number(nano) / 1e9,
      breached: nano >= 20000000000n,
    })),
    healthProblem,
  };
}
for (const fixture of fixtures) {
  test(fixture.name, () => {
    assert.deepEqual(evaluate(fixture.events, fixture.now), fixture.expected);
  });
}

test("one hundred fractional observations equal exactly 20", () => {
  const rows = Array.from({ length: 100 }, (_, index) => {
    const row = structuredClone(fixtures[1].events[0]);
    row.fields = {
      ...row.fields,
      accountingId: `fractional-${index}`,
      grossCreditValueUsd: 0.2,
      grossCreditValueNanoUsd: "200000000",
    };
    return row;
  });
  assert.deepEqual(evaluate(rows, "2026-09-15T12:00:00Z"), {
    days: [{ day: "2026-09-15", total: 20, breached: true }],
    healthProblem: false,
  });
});

for (const [name, fields] of [
  ["missing billing mode", { billingMode: null }],
  ["invalid token quantity", { inputTokens: -1 }],
  ["unsupported exact integer value", { grossCreditValueNanoUsd: null }],
  ["unsupported cost version", { costVersion: 2 }],
]) {
  test(name + " is unhealthy", () => {
    const row = structuredClone(fixtures[1].events[0]);
    row.fields = { ...row.fields, ...fields };
    assert.equal(evaluate([row], "2026-09-15T12:00:00Z").healthProblem, true);
  });
}
