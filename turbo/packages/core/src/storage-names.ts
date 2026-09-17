/**
 * Storage name generation functions for agent instructions and skills.
 * These functions create standardized storage names used across CLI and Web packages.
 */

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
 * Generate the storage name for agent instructions.
 * Format: agent-instructions@{agentName}
 *
 * @param agentName - Name of the agent (compose name)
 * @returns Storage name for the instructions
 */
export function getInstructionsStorageName(agentName: string): string {
  return `agent-instructions@${agentName}`;
}

/**
 * Generate the storage name for an agent skill.
 * Format: agent-skills@{fullPath}
 *
 * @param fullPath - Full path from GitHub URL (e.g., "owner/repo/tree/branch/path")
 * @returns Storage name for the skill
 */
export function getSkillStorageName(fullPath: string): string {
  return `agent-skills@${fullPath}`;
}

/**
 * Generate the storage name for a custom skill.
 * Format: custom-skill@{skillName}
 *
 * @param skillName - Name of the custom skill (e.g., "my-skill")
 * @returns Storage name for the custom skill
 */
export function getCustomSkillStorageName(skillName: string): string {
  return `custom-skill@${skillName}`;
}

/**
 * Generate the stable system storage name for an Official Workflow Definition.
 * Every immutable revision of one Definition is registered beneath this one
 * name-derived storage identity.
 */
export function getOfficialWorkflowDefinitionStorageName(
  definitionName: string,
): string {
  return `official-workflow@${definitionName}`;
}

/**
 * Generate the storage name for a published presentation template package.
 * Format: presentation-template@{templateId}
 *
 * Derived from the row id, so the package needs no column of its own and there
 * is nothing to keep in sync.
 *
 * @param templateId - Presentation template row id
 * @returns Storage name for the template's guidance package
 */
export function getPresentationTemplateStorageName(templateId: string): string {
  return `presentation-template@${templateId}`;
}

/**
 * Generate the storage name for a user template's guidance package.
 * Derived from the row id, so the template needs no column pointing at it.
 *
 * @param templateId - User template row id
 * @returns Storage name for the template's guidance package
 */
export function getUserTemplateStorageName(templateId: string): string {
  return `user-template@${templateId}`;
}

/**
 * Generate the storage name for a custom connector skill.
 * The connector id is used so renaming the connector does not orphan storage.
 */
export function getCustomConnectorSkillStorageName(
  connectorId: string,
): string {
  return `custom-connector-skill@${connectorId}`;
}

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
