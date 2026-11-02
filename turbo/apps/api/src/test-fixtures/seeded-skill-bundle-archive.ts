import { readFileSync } from "node:fs";

import seededSkillBundles from "../scripts/dev-seed-skill-bundles.json";

export function seededSkillBundleArchive(
  archiveKey: string,
): Buffer | undefined {
  const bundle = seededSkillBundles.find((skill) => {
    return `bundles/v1/${skill.contentBundle.sha256}.tar.gz` === archiveKey;
  });
  if (bundle) {
    return readFileSync(
      new URL(
        `../scripts/dev-seed-skill-bundles/${bundle.name}.tar.gz`,
        import.meta.url,
      ),
    );
  }
  return undefined;
}
