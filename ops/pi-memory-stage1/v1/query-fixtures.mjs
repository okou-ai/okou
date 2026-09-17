import { readFile } from "node:fs/promises";

// Inputs and expected service results only; no local APL interpreter or cost oracle.
const base = JSON.parse(
  await readFile(new URL("fixtures.json", import.meta.url), "utf8"),
);
const fixtures = structuredClone(base);
const empty = { days: [], healthProblem: false };
const twenty = {
  days: [{ day: "2026-09-15", total: 20, breached: true }],
  healthProblem: false,
};
function row(fields = {}, root = {}) {
  const event = structuredClone(base[1].events[0]);
  return { ...event, ...root, fields: { ...event.fields, ...fields } };
}
function add(name, events, expected, now = "2026-09-15T12:00:00Z") {
  fixtures.push({ name, events, expected, now });
}
add("all off with every D column absent", [], empty);
add(
  "context and operation only; all accounting columns absent",
  [row()].map((event) => ({
    ...event,
    fields: { context: "PiMemoryStage1Cost", operation: "pi_memory_stage1" },
  })),
  { days: [], healthProblem: true, healthDays: ["2026-09-15"] },
);
const missingMode = row();
delete missingMode.fields.billingMode;
add("missing billing mode column", [missingMode], {
  days: [],
  healthProblem: true,
});
add("unsupported cost version", [row({ costVersion: 2 })], {
  days: [],
  healthProblem: true,
});
for (const [name, fields] of [
  ["missing token column", { inputTokens: null }],
  ["negative token quantity", { inputTokens: -1 }],
  ["fractional token quantity", { outputTokens: 1.5 }],
  ["malformed token quantity", { cacheReadTokens: "invalid" }],
])
  add(name, [row(fields)], { ...twenty, healthProblem: true });
for (const [name, fields] of [
  ["missing exact nano value", { grossCreditValueNanoUsd: null }],
  ["fractional nano string", { grossCreditValueNanoUsd: "1.5" }],
  ["invalid nano string", { grossCreditValueNanoUsd: "invalid" }],
  ["negative nano string", { grossCreditValueNanoUsd: "-1" }],
  [
    "out of int64 nano value",
    { grossCreditValueNanoUsd: "9223372036854775808" },
  ],
  ["missing display value", { grossCreditValueUsd: null }],
  ["negative display value", { grossCreditValueUsd: -1 }],
  ["malformed display value", { grossCreditValueUsd: "NaN" }],
  ["missing pricing status", { pricingStatus: null }],
  [
    "fallback-only pricing",
    {
      pricingStatus: "fallback_price",
      grossCreditValueUsd: null,
      grossCreditValueNanoUsd: null,
    },
  ],
])
  add(name, [row(fields)], { days: [], healthProblem: true });
add(
  "one hundred fractional observations equal exactly 20",
  Array.from({ length: 100 }, (_, i) =>
    row({
      accountingId: `fractional-${i}`,
      grossCreditValueUsd: 0.2,
      grossCreditValueNanoUsd: "200000000",
    }),
  ),
  twenty,
);
add(
  "one nano below threshold",
  [
    row({
      grossCreditValueUsd: 19.999999999,
      grossCreditValueNanoUsd: "19999999999",
    }),
  ],
  {
    days: [{ day: "2026-09-15", total: 19.999999999, breached: false }],
    healthProblem: false,
  },
);
add(
  "one nano above threshold",
  [
    row({
      grossCreditValueUsd: 20.000000001,
      grossCreditValueNanoUsd: "20000000001",
    }),
  ],
  {
    days: [{ day: "2026-09-15", total: 20.000000001, breached: true }],
    healthProblem: false,
  },
);
add(
  "identity model and quantity conflict",
  [
    row(),
    row({
      model: "conflicting-model",
      outputTokens: 1,
      observedAt: "2026-09-15T11:00:00.000Z",
    }),
  ],
  {
    ...twenty,
    healthProblem: true,
    healthDays: ["2026-09-15"],
  },
);
const earlier = row({
  accountingAt: "2026-09-13T10:00:00.000Z",
  observedAt: "2026-09-15T09:00:00.000Z",
});
add(
  "choose first before day filtering; never replace expired identity",
  [row(), earlier],
  {
    days: [],
    healthProblem: true,
    healthDays: ["2026-09-15"],
  },
);
const tied = [row(), row({ accountingAt: "2026-09-14T10:00:00.000Z" })];
for (const [order, events] of [
  ["forward", tied],
  ["reverse", [...tied].reverse()],
])
  add(`tied identity anchor conflict ${order}`, events, {
    days: [{ day: "2026-09-14", total: 20, breached: true }],
    healthProblem: true,
    healthDays: ["2026-09-15"],
  });
for (const now of [
  "2026-09-15T23:59:59Z",
  "2026-09-16T00:00:00Z",
  "2026-09-16T00:05:00Z",
])
  add(`stable incident across evaluation ${now}`, [row()], twenty, now);
add(
  "group expires after previous-day reconciliation window",
  [row()],
  empty,
  "2026-09-17T00:00:00Z",
);
add(
  "late previous-day health retains ingestion day",
  [
    row({
      pricingStatus: "missing_price",
      grossCreditValueUsd: null,
      grossCreditValueNanoUsd: null,
    }),
  ],
  {
    days: [],
    healthProblem: true,
    healthDays: ["2026-09-15"],
  },
  "2026-09-16T00:05:00Z",
);
add(
  "non-api and non-info exclusion",
  [row({}, { source: "runner" }), row({}, { level: "debug" })],
  empty,
);
add(
  "unsafe aggregate is unavailable with explicit precision health",
  [
    row({
      accountingId: "large-a",
      grossCreditValueUsd: 4503599.627370496,
      grossCreditValueNanoUsd: "4503599627370496",
    }),
    row({
      accountingId: "large-b",
      grossCreditValueUsd: 4503599.627370497,
      grossCreditValueNanoUsd: "4503599627370497",
    }),
  ],
  { days: [], healthProblem: true, healthDays: ["2026-09-15"] },
);
add(
  "unsafe individual nano value is unavailable",
  [
    row({
      grossCreditValueUsd: 9007199.254740992,
      grossCreditValueNanoUsd: "9007199254740992",
    }),
  ],
  {
    days: [],
    healthProblem: true,
    healthDays: ["2026-09-15"],
  },
);
add(
  "millisecond order keeps the earlier observation before a repriced one",
  [
    row({ observedAt: "2026-09-15T10:00:01.001Z" }),
    row({
      observedAt: "2026-09-15T10:00:01.000Z",
      grossCreditValueUsd: 1,
      grossCreditValueNanoUsd: "1000000000",
    }),
  ],
  {
    days: [{ day: "2026-09-15", total: 1, breached: false }],
    healthProblem: true,
  },
);
export default fixtures;
