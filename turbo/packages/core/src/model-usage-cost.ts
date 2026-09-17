/** Fractional credit value, before per-category billing ceil or allowances. */
interface ModelUsageCostEntry {
  readonly category: string;
  readonly quantity: number;
}

interface ModelUsageCostPrice {
  readonly category: string;
  readonly unitPrice: number;
  readonly unitSize: number;
}

type UnavailablePrice =
  | "invalid_usage"
  | "missing_price"
  | "fallback_price"
  | "invalid_price";

export function valueModelUsage(
  entries: readonly ModelUsageCostEntry[],
  prices: readonly ModelUsageCostPrice[],
):
  | {
      readonly pricingStatus: "available";
      readonly grossCreditValueUsd: number;
      readonly grossCreditValueNanoUsd: string | null;
    }
  | {
      readonly pricingStatus: UnavailablePrice;
      readonly grossCreditValueUsd: null;
      readonly grossCreditValueNanoUsd: null;
    } {
  let numerator = 0n;
  let denominator = 1n;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.quantity) || entry.quantity < 0) {
      return {
        pricingStatus: "invalid_usage",
        grossCreditValueUsd: null,
        grossCreditValueNanoUsd: null,
      };
    }
    const price = prices.find((row) => {
      return row.category === entry.category;
    });
    if (!price) {
      return {
        pricingStatus: prices.some((row) => {
          return row.category === "__fallback__";
        })
          ? "fallback_price"
          : "missing_price",
        grossCreditValueUsd: null,
        grossCreditValueNanoUsd: null,
      };
    }
    if (
      !Number.isSafeInteger(price.unitPrice) ||
      price.unitPrice < 0 ||
      !Number.isSafeInteger(price.unitSize) ||
      price.unitSize <= 0
    ) {
      return {
        pricingStatus: "invalid_price",
        grossCreditValueUsd: null,
        grossCreditValueNanoUsd: null,
      };
    }
    const divisor = BigInt(price.unitSize) * 1000n;
    numerator =
      numerator * divisor +
      BigInt(entry.quantity) * BigInt(price.unitPrice) * denominator;
    denominator *= divisor;
    const common = gcd(numerator, denominator);
    numerator /= common;
    denominator /= common;
  }
  return {
    pricingStatus: "available",
    grossCreditValueUsd: Number(numerator) / Number(denominator),
    // Exact fixed-point transport for APL's integer sum. Never ceil a category
    // or silently round a valid rate that cannot be represented at this scale.
    grossCreditValueNanoUsd:
      (numerator * 1_000_000_000n) % denominator === 0n &&
      (numerator * 1_000_000_000n) / denominator <= 9_223_372_036_854_775_807n
        ? ((numerator * 1_000_000_000n) / denominator).toString()
        : null,
  };
}

function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    [left, right] = [right, left % right];
  }
  return left;
}
