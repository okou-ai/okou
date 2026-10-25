import { pgTable } from "drizzle-orm/pg-core";
import { usageEventColumns } from "../columns/usage-event";

/** Application mapping without retired managed-data pricing snapshots. */
export const usageEvent = pgTable("usage_event", usageEventColumns());
