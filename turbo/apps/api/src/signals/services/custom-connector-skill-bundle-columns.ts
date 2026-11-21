import { orgCustomConnectorSkillBundles } from "@okouai/db/runtime/org-custom-connector-skill-bundle";
import type { PreparedCustomConnectorSkill } from "./custom-connector-skill-bundle.service";

/** Read preparation metadata in the same statement as its authorized revision. */
export function customConnectorSkillBundleSelection() {
  return {
    skillStorageVersionId: orgCustomConnectorSkillBundles.skillStorageVersionId,
    skillContentBundle: orgCustomConnectorSkillBundles.skillContentBundle,
    skillContentBundleSourceVersionId:
      orgCustomConnectorSkillBundles.skillContentBundleSourceVersionId,
  } as const;
}

export type CustomConnectorSkillBundleRow = Pick<
  typeof orgCustomConnectorSkillBundles.$inferSelect,
  keyof ReturnType<typeof customConnectorSkillBundleSelection>
>;

/** The version-pair constraint and rollback readers require the legacy mirror. */
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
