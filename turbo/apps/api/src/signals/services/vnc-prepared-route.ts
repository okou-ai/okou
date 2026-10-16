import { and, inArray, isNull, or } from "drizzle-orm";
import { vncConnections } from "@okouai/db/schema/vnc-connection";

/**
 * Storage expands before native owner/Runner authority is prepared. Admit only
 * routes these readers can interpret. C3 (#40517) replaces this predicate before
 * G publishes native routes; H (#40229) audits the transition inventory.
 */
export const preparedVncRoutePredicate = and(
  inArray(vncConnections.transportType, ["direct", "ssh"]),
  or(
    isNull(vncConnections.kdcTransportType),
    inArray(vncConnections.kdcTransportType, ["direct", "ssh"]),
  ),
);
