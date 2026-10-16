import type { WalletSpend } from "@okouai/api-contracts/contracts/wallet";

import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import { settleIncludingAbort } from "../utils";

/** The request telemetry boundary owns the flush; never delay wallet operations. */
function recordUsage(fields: Readonly<Record<string, string | boolean>>): void {
  waitUntil(
    settleIncludingAbort(() => {
      return ingestToAxiom(getDatasetName("web-logs"), [
        {
          _time: nowDate().toISOString(),
          type: "link_wallet_usage",
          source: "api",
          level: "info",
          ...fields,
        },
      ]);
    }),
  );
}

interface WalletUsageOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

export function recordWalletConnectionUsage(
  owner: Omit<WalletUsageOwner, "agentId"> & {
    readonly agentId?: string | null;
  },
  authorizationId: string,
  event:
    | "connection_started"
    | "connection_completed"
    | "connection_failed"
    | "connection_revoked",
): void {
  recordUsage({
    event,
    eventId: `${authorizationId}:${event}`,
    userId: owner.userId,
    orgId: owner.orgId,
    ...(owner.agentId ? { agentId: owner.agentId } : {}),
    authorizationId,
  });
}

/**
 * Count distinct userId for adoption and spendId for purchases. Repeated status
 * reads and credential downloads share an eventId; they are not new purchases.
 * Status is observed at request time, and approval or credentials are not proof
 * of payment. Explicit fields exclude card data, tokens, URLs and purchase text.
 */
export function recordWalletSpendUsage(
  spend: WalletUsageOwner & {
    readonly id: string;
    readonly authorizationId: string;
    readonly intentId: string;
    readonly test: boolean;
  },
  event: "spend_requested" | "spend_status_observed" | "credentials_retrieved",
  status: WalletSpend["status"],
): void {
  recordUsage({
    event,
    eventId: `${spend.id}:${event}:${status}`,
    userId: spend.userId,
    orgId: spend.orgId,
    agentId: spend.agentId,
    authorizationId: spend.authorizationId,
    spendId: spend.id,
    intentId: spend.intentId,
    test: spend.test,
    status,
  });
}
