import { cronAuditRunSettlementContract } from "@okouai/api-contracts/contracts/run-settlement";
import { command } from "ccstate";

import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { createRunSettlementAudit } from "../services/run-settlement-audit.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const audit$ = createRunSettlementAudit(
  queryOf(cronAuditRunSettlementContract.audit),
);

const auditRoute$ = command(async ({ get }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const report = await get(audit$);
  signal.throwIfAborted();
  return { status: 200 as const, body: report };
});

export const cronAuditRunSettlementRoutes: readonly RouteEntry[] = [
  { route: cronAuditRunSettlementContract.audit, handler: auditRoute$ },
];
