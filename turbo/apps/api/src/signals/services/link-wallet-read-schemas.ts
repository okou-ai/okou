import * as z from "zod";

const paymentMethod = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  type: z.string(),
  name: z.string(),
  nickname: z.string().nullable().optional(),
  is_default: z.boolean(),
  card_details: z
    .object({
      brand: z.string(),
      last4: z.string().regex(/^\d{4}$/),
      exp_month: z.number().int().min(1).max(12),
      exp_year: z.number().int(),
    })
    .nullable()
    .optional(),
  bank_account_details: z
    .object({
      last4: z.string().regex(/^\d{4}$/),
      bank_name: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  capabilities: z
    .record(
      z.string(),
      z.object({
        eligible: z.boolean(),
        ineligibility_reasons: z.array(z.string()),
      }),
    )
    .nullable()
    .optional(),
});

export const linkPaymentMethodSchema = paymentMethod.transform((value) => {
  return {
    id: value.id,
    type: value.type,
    name: value.name,
    nickname: value.nickname,
    isDefault: value.is_default,
    card: value.card_details
      ? {
          brand: value.card_details.brand,
          last4: value.card_details.last4,
          expMonth: value.card_details.exp_month,
          expYear: value.card_details.exp_year,
        }
      : value.card_details,
    bankAccount: value.bank_account_details
      ? {
          last4: value.bank_account_details.last4,
          bankName: value.bank_account_details.bank_name,
        }
      : value.bank_account_details,
    capabilities: value.capabilities
      ? Object.fromEntries(
          Object.entries(value.capabilities).map(([key, capability]) => {
            return [
              key,
              {
                eligible: capability.eligible,
                ineligibilityReasons: capability.ineligibility_reasons,
              },
            ];
          }),
        )
      : value.capabilities,
  };
});

export const linkTransactionsSchema = z
  .object({
    data: z.array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
        source_id: z.string().nullable(),
        amount: z.number().int().safe(),
        currency: z.string(),
        created_date: z.iso.date(),
        description: z.string(),
        origin: z.literal("link"),
        category: z.string().nullable(),
        status: z.string(),
      }),
    ),
    has_more: z.boolean().optional(),
  })
  .transform((value) => {
    return {
      data: value.data.map((transaction) => {
        return {
          id: transaction.id,
          sourceId: transaction.source_id,
          amount: transaction.amount,
          currency: transaction.currency,
          date: transaction.created_date,
          description: transaction.description,
          origin: transaction.origin,
          category: transaction.category,
          status: transaction.status,
        };
      }),
      hasMore: value.has_more ?? null,
      nextCursor:
        value.has_more !== false ? (value.data.at(-1)?.id ?? null) : null,
    };
  });

const limit = z.object({
  limit: z.number().int().nullable(),
  used: z.number().int().optional(),
  remaining: z.number().int().nullable().optional(),
});
export const linkUserInfoSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    default_spend_request_currency: z.string().optional(),
    agent_wallet_spend_limits: z
      .object({ per_transaction: limit, daily: limit, thirty_day: limit })
      .optional(),
    agent_wallet_verification_requirement: z
      .object({ status: z.string(), action_url: z.string().nullable() })
      .optional(),
  })
  .transform((value) => {
    const limits = value.agent_wallet_spend_limits;
    const verification = value.agent_wallet_verification_requirement;
    return {
      id: value.id,
      name: value.name,
      email: value.email,
      defaultCurrency: value.default_spend_request_currency,
      spendLimits: limits
        ? {
            perTransaction: limits.per_transaction,
            daily: limits.daily,
            thirtyDay: limits.thirty_day,
          }
        : undefined,
      verification: verification
        ? {
            status: verification.status,
            actionUrl: verification.action_url,
          }
        : undefined,
    };
  });
