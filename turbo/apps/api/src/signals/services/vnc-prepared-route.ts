import { and, inArray, isNull, or } from "drizzle-orm";
import { vncConnections } from "@okouai/db/schema/vnc-connection";

/**
 * Only the legacy public owner update remains restricted. G (#40228) replaces
 * its Direct/SSH preparation before native authoring; H (#40229) audits removal.
 */
export const legacyVncOwnerWritePredicate = and(
  inArray(vncConnections.transportType, ["direct", "ssh"]),
  or(
    isNull(vncConnections.kdcTransportType),
    inArray(vncConnections.kdcTransportType, ["direct", "ssh"]),
  ),
);
