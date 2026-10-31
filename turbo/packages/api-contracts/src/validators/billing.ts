import { literal, union, type ZodType } from "zod";

export const USAGE_PACKS_USD = [20, 50, 100, 200] as const;
export type UsagePackUsd = (typeof USAGE_PACKS_USD)[number];

export const usagePackUsdSchema: ZodType<UsagePackUsd> = union([
  literal(20),
  literal(50),
  literal(100),
  literal(200),
]);
