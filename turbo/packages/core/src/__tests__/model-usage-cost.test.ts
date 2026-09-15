import { describe, expect, it } from "vitest";
import { valueModelUsage } from "../model-usage-cost";

const entries = [
  { category: "tokens.input", quantity: 10 },
  { category: "tokens.output", quantity: 8 },
  { category: "tokens.cache_read", quantity: 2 },
  { category: "tokens.cache_creation", quantity: 3 },
];
const prices = entries.map((row, i) => {
  return {
    category: row.category,
    unitPrice: [1000, 4000, 100, 1250][i]!,
    unitSize: 1_000_000,
  };
});

describe("fractional gross model credit value", () => {
  it("values four quantities before category ceil, allowances or USD conversion", () => {
    const result = valueModelUsage(entries, prices);
    expect(result.pricingStatus).toBe("available");
    expect(result.grossCreditValueUsd).toBeCloseTo(0.00004595, 12);
    expect(result.grossCreditValueUsd).not.toBe(4 / 1000);
  });
  it("preserves valid zero prices", () => {
    expect(
      valueModelUsage(
        entries,
        prices.map((price) => {
          return { ...price, unitPrice: 0 };
        }),
      ),
    ).toEqual({
      pricingStatus: "available",
      grossCreditValueUsd: 0,
      grossCreditValueNanoUsd: "0",
    });
  });
  it.each([
    { rows: [], status: "missing_price" },
    {
      rows: [{ category: "__fallback__", unitPrice: 1, unitSize: 1 }],
      status: "fallback_price",
    },
    { rows: [{ ...prices[0]!, unitSize: 0 }], status: "invalid_price" },
    { rows: [{ ...prices[0]!, unitPrice: -1 }], status: "invalid_price" },
    { rows: [{ ...prices[0]!, unitPrice: Infinity }], status: "invalid_price" },
  ])("reports $status without a fabricated zero", ({ rows, status }) => {
    expect(valueModelUsage(entries, rows)).toEqual({
      pricingStatus: status,
      grossCreditValueUsd: null,
      grossCreditValueNanoUsd: null,
    });
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unavailable quantity %s",
    (quantity) => {
      expect(valueModelUsage([{ ...entries[0]!, quantity }], prices)).toEqual({
        pricingStatus: "invalid_usage",
        grossCreditValueUsd: null,
        grossCreditValueNanoUsd: null,
      });
    },
  );
});

it("retains a valid fractional rate while exposing unsupported APL integer precision", () => {
  expect(
    valueModelUsage(
      [{ category: "tokens.input", quantity: 1 }],
      [{ category: "tokens.input", unitPrice: 1, unitSize: 3 }],
    ),
  ).toEqual({
    pricingStatus: "available",
    grossCreditValueUsd: 1 / 3000,
    grossCreditValueNanoUsd: null,
  });
});
