import {
  array,
  boolean,
  iso,
  literal,
  number,
  object,
  record,
  string,
} from "zod";

const paymentMethod = object({
  id: string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  type: string(),
  name: string(),
  nickname: string().nullable().optional(),
  is_default: boolean(),
  card_details: object({
    brand: string(),
    last4: string().regex(/^\d{4}$/),
    exp_month: number().int().min(1).max(12),
    exp_year: number().int(),
  })
    .nullable()
    .optional(),
  bank_account_details: object({
    last4: string().regex(/^\d{4}$/),
    bank_name: string().nullable().optional(),
  })
    .nullable()
    .optional(),
  capabilities: record(
    string(),
    object({
      eligible: boolean(),
      ineligibility_reasons: array(string()),
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

export const linkTransactionsSchema = object({
  data: array(
    object({
      id: string().regex(/^[A-Za-z0-9_-]{1,256}$/),
      source_id: string().nullable(),
      amount: number().int().safe(),
      currency: string(),
      created_date: iso.date(),
      description: string(),
      origin: literal("link"),
      category: string().nullable(),
      status: string(),
    }),
  ),
  has_more: boolean().optional(),
}).transform((value) => {
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

const limit = object({
  limit: number().int().nullable(),
  used: number().int().optional(),
  remaining: number().int().nullable().optional(),
});
export const linkUserInfoSchema = object({
  id: string().optional(),
  name: string().nullable().optional(),
  email: string().nullable().optional(),
  default_spend_request_currency: string().optional(),
  agent_wallet_spend_limits: object({
    per_transaction: limit,
    daily: limit,
    thirty_day: limit,
  }).optional(),
  agent_wallet_verification_requirement: object({
    status: string(),
    action_url: string().nullable(),
  }).optional(),
}).transform((value) => {
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
