import { pgTable } from "drizzle-orm/pg-core";
import { computerUseHostColumns } from "../columns/computer-use-host";

// Omitting token_hash also removes implicit INSERT, SELECT and RETURNING
// references. The physical schema retains it until this API has drained its
// predecessors and incompatible rollback targets; contraction is #37997.
export const computerUseHosts = pgTable(
  "computer_use_hosts",
  computerUseHostColumns(),
);
