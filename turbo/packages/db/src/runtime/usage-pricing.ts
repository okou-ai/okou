import { pgTable } from "drizzle-orm/pg-core";
import { usagePricingColumns } from "../columns/usage-pricing";

/** Application mapping without the retired managed-provider cost conversion. */
export const usagePricing = pgTable("usage_pricing", usagePricingColumns());
