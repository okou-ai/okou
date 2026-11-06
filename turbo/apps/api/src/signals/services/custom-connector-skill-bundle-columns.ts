import { orgCustomConnectorSkillBundles } from "@okouai/db/runtime/org-custom-connector-skill-bundle";

/** Read preparation metadata in the same statement as its authorized revision. */
export function customConnectorSkillBundleSelection() {
  return {
    skillContentBundle: orgCustomConnectorSkillBundles.skillContentBundle,
    skillContentBundleSourceVersionId:
      orgCustomConnectorSkillBundles.skillContentBundleSourceVersionId,
  } as const;
}
