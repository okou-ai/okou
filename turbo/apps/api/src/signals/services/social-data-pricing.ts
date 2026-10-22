import { SocialDataProviderError } from "./social-data-provider-error";

export function creditsFor(
  cost: number,
  unitPrice: number,
  unitSize: number,
): number {
  if (
    ![cost, unitPrice, unitSize].every(Number.isSafeInteger) ||
    cost < 0 ||
    unitPrice < 0 ||
    unitSize <= 0
  ) {
    throw new SocialDataProviderError(
      "PRICING_NOT_CONFIGURED",
      "Social data pricing is unavailable.",
      503,
    );
  }
  const denominator = BigInt(unitSize);
  const result =
    (BigInt(cost) * BigInt(unitPrice) + denominator - 1n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_LIMIT_EXCEEDED",
      "The requested operation exceeds the supported budget.",
      422,
    );
  }
  return Number(result);
}
