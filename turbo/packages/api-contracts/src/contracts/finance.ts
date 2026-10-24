import { z } from "zod";

export const FINANCE_DEFAULT_RANGE = "1y" as const;
export const FINANCE_DEFAULT_INTERVAL = "1d" as const;
export const FINANCE_MAX_QUERY_CHARS = 512;
export const FINANCE_MAX_SYMBOL_CHARS = 64;

export const financeRangeSchema = z.enum([
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "5y",
  "10y",
  "ytd",
  "max",
]);

export const financeIntervalSchema = z.enum([
  "1m",
  "2m",
  "5m",
  "15m",
  "30m",
  "60m",
  "1d",
  "1wk",
  "1mo",
]);

export const financeSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(FINANCE_MAX_QUERY_CHARS),
});

const financeSymbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(FINANCE_MAX_SYMBOL_CHARS);

export const financeProfileRequestSchema = z.object({
  symbol: financeSymbolSchema,
});

export const financeQuoteRequestSchema = z.object({
  symbol: financeSymbolSchema,
});

export const financeChartRequestSchema = z.object({
  symbol: financeSymbolSchema,
  range: financeRangeSchema.default(FINANCE_DEFAULT_RANGE),
  interval: financeIntervalSchema.default(FINANCE_DEFAULT_INTERVAL),
});

export const financeOperationSchema = z.enum([
  "search",
  "profile",
  "quote",
  "chart",
]);

export const financeResponseSchema = z.object({
  operation: financeOperationSchema,
  provider: z.literal("apidojo"),
  billingCategory: z.literal("request"),
  billingQuantity: z.literal(1),
  creditsCharged: z.number().int().nonnegative().nullable(),
  result: z.unknown(),
});

export type FinanceRange = z.infer<typeof financeRangeSchema>;
export type FinanceInterval = z.infer<typeof financeIntervalSchema>;
export type FinanceSearchRequest = z.infer<typeof financeSearchRequestSchema>;
export type FinanceProfileRequest = z.infer<typeof financeProfileRequestSchema>;
export type FinanceQuoteRequest = z.infer<typeof financeQuoteRequestSchema>;
export type FinanceChartRequest = z.infer<typeof financeChartRequestSchema>;
export type FinanceResponse = z.infer<typeof financeResponseSchema>;
