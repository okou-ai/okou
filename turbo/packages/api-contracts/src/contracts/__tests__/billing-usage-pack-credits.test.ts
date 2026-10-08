import { describe, expect, it } from "vitest";
import { billingUsagePackCreditsContract } from "../billing";

const responseSchema = billingUsagePackCreditsContract.get.responses[200];
const legacyBalance = {
  totalCredits: 50,
  purchasedCredits: 40,
  bonusCredits: 10,
  creditGrants: [
    {
      id: "grant-purchased",
      grantType: "purchased",
      amount: 40,
      remaining: 40,
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-11-01T00:00:00.000Z",
    },
  ],
};

describe("usage pack credit response compatibility", () => {
  it("accepts older API balances without net or debt fields for the member and admin list", () => {
    const response = {
      ...legacyBalance,
      memberCredits: [{ ...legacyBalance, memberId: "member-1" }],
    };
    expect(responseSchema.parse(response)).toStrictEqual(response);
  });

  it("preserves signed net balances and nonnegative spendable fields for each member", () => {
    const response = {
      totalCredits: 0,
      netCredits: -23,
      debtCredits: 23,
      purchasedCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
      memberCredits: [
        {
          totalCredits: 0,
          netCredits: -23,
          debtCredits: 23,
          purchasedCredits: 0,
          bonusCredits: 0,
          creditGrants: [],
          memberId: "member-1",
        },
        {
          ...legacyBalance,
          netCredits: 27,
          debtCredits: 0,
          memberId: "member-2",
        },
      ],
    };
    expect(responseSchema.parse(response)).toStrictEqual(response);
  });

  it.each([
    { netCredits: 0.5 },
    { debtCredits: -1 },
    { debtCredits: 0.5 },
    { totalCredits: -1 },
    { purchasedCredits: -1 },
    { bonusCredits: -1 },
  ])(
    "rejects invalid credit balance fields %j in both response scopes",
    (fields) => {
      const invalidBalance = { ...legacyBalance, ...fields };
      expect(responseSchema.safeParse(invalidBalance).success).toBe(false);
      expect(
        responseSchema.safeParse({
          ...legacyBalance,
          memberCredits: [{ ...invalidBalance, memberId: "member-1" }],
        }).success,
      ).toBe(false);
    },
  );

  it("keeps grant remainders strictly positive rather than representing debt as a grant", () => {
    expect(
      responseSchema.safeParse({
        ...legacyBalance,
        creditGrants: [{ ...legacyBalance.creditGrants[0], remaining: -23 }],
      }).success,
    ).toBe(false);
  });
});
