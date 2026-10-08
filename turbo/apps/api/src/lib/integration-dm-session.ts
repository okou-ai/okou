export const INTEGRATION_DM_SESSION_PREFIX = "direct-message:";

/**
 * Route key for the main direct-message conversation. Each integration
 * identity (connection row) owns exactly one DM thread, so the key carries no
 * agent or model. Keys written before Release 7 had the shape
 * `direct-message:<agentId>:<model>[:priority]`; they still match the prefix.
 */
export const INTEGRATION_DM_SESSION_KEY = `${INTEGRATION_DM_SESSION_PREFIX}main`;

export function isIntegrationDmSessionKey(key: string): boolean {
  return key.startsWith(INTEGRATION_DM_SESSION_PREFIX);
}
