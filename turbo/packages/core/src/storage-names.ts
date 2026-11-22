/**
 * Sentinel userId for organization-owned storages.
 * Organization-owned storages are shared resources within an organization.
 * They use this constant instead of a real userId so the
 * (orgId, userId, name) constraint keeps them unique per organization.
 */
export const VOLUME_ORG_USER_ID = "__org__";

/**
 * Sentinel orgId for system-level storages (shared across all orgs).
 * Used for official skills that are cached globally, not per-org.
 */
export const SYSTEM_ORG_ID = "__system__";

/**
 * Generate the framework-visible name for a custom connector skill.
 * Includes connector identity so it cannot collide with builtin/workflow skills.
 */
export function getCustomConnectorSkillName(
  connectorSlug: string,
  connectorId: string,
): string {
  const base = connectorSlug.startsWith("_")
    ? connectorSlug.slice(1)
    : connectorSlug;
  return `custom-${base.slice(0, 48)}-${connectorId.replaceAll("-", "").slice(0, 8)}`;
}

/**
 * Reserved name of the per-user memory storage that Okou auto-injects into
 * every agent run. It is owned by the user and mounted into the sandbox at a
 * framework-specific path.
 */
export const MEMORY_ARTIFACT_NAME = "memory";
