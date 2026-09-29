import type { VncConnectionResponse } from "@okouai/api-contracts/contracts/vnc-connections";

/** Existing password-bound fixtures must never silently become credentialless. */
export function requireVncCredentialId(
  connection: VncConnectionResponse,
): string {
  if (!("credentialId" in connection)) {
    throw new Error("Expected a password-bound VNC connection");
  }
  return connection.credentialId;
}
