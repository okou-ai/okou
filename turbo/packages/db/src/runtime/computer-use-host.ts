import { pgTable } from "drizzle-orm/pg-core";
import { computerUseHostColumns } from "../columns/computer-use-host";

/** Application mapping. Omits physical DDL declarations. */
export const computerUseHosts = pgTable(
  "computer_use_hosts",
  computerUseHostColumns(),
);
