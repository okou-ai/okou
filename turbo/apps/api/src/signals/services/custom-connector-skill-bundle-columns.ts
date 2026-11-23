import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import type { PreparedCustomConnectorSkill } from "./custom-connector-skill-bundle.service";

export function customConnectorSkillBundleSelection() {
  return {
    skillContentBundle: orgCustomConnectors.skillContentBundle,
    skillContentBundleSourceVersionId:
      orgCustomConnectors.skillContentBundleSourceVersionId,
  } as const;
}

export type CustomConnectorSkillBundleRow = Pick<
  typeof orgCustomConnectors.$inferSelect,
  keyof ReturnType<typeof customConnectorSkillBundleSelection>
>;

export function customConnectorSkillBundleValues(
  skill: PreparedCustomConnectorSkill | null,
) {
  return {
    skillContentBundle: skill?.contentBundle ?? null,
    skillContentBundleSourceVersionId: skill?.sourceVersionId ?? null,
  };
}
