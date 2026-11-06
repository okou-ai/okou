import { readFileSync } from "node:fs";

import connectorSkillBundle from "./connector-skill-bundle.json";

import seededSkillBundles from "../scripts/dev-seed-skill-bundles.json";

export function seededSkillBundleArchive(
  archiveKey: string,
): Buffer | undefined {
  if (archiveKey === `bundles/v1/${connectorSkillBundle.sha256}.tar.gz`) {
    return Buffer.from(connectorSkillBundle.archiveBase64, "base64");
  }
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
