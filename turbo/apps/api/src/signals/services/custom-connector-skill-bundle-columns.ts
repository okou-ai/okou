import { and, eq } from "drizzle-orm";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorSkillPublications } from "@okouai/db/schema/org-custom-connector-skill-publication";
import type { PreparedCustomConnectorSkill } from "./custom-connector-skill-bundle.service";

export function customConnectorSkillPublicationJoin() {
  return and(
    eq(orgCustomConnectorSkillPublications.id, orgCustomConnectors.id),
    eq(orgCustomConnectorSkillPublications.orgId, orgCustomConnectors.orgId),
  );
}

export function customConnectorSkillBundleSelection() {
  return {
    skillContentBundle: orgCustomConnectorSkillPublications.skillContentBundle,
    skillContentBundleSourceVersionId:
      orgCustomConnectorSkillPublications.skillContentBundleSourceVersionId,
  } as const;
}

export type CustomConnectorSkillBundleRow = Pick<
  typeof orgCustomConnectors.$inferSelect,
  keyof ReturnType<typeof customConnectorSkillBundleSelection>
>;

/** Keep both source IDs in sync until the native publication migration has shipped. */
export function customConnectorSkillBundleValues(
  skill: PreparedCustomConnectorSkill | null,
) {
  const sourceVersionId = skill?.sourceVersionId ?? null;
  return {
    skillContentBundle: skill?.contentBundle ?? null,
    skillContentBundleSourceVersionId: sourceVersionId,
    skillStorageVersionId: sourceVersionId,
  };
}
