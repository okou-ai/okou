import { eq } from "drizzle-orm";
import { pgView } from "drizzle-orm/pg-core";
import { orgCustomConnectors } from "./org-custom-connector";

// A preceding writer can edit or clear only the selected source. Keep its
// previous bundle out of reads until all such writers have retired.
export const orgCustomConnectorSkillPublications = pgView(
  "org_custom_connector_skill_publications",
)
  .with({ securityInvoker: true })
  .as((db) => {
    return db
      .select({
        id: orgCustomConnectors.id,
        orgId: orgCustomConnectors.orgId,
        skillContentBundle: orgCustomConnectors.skillContentBundle,
        skillContentBundleSourceVersionId:
          orgCustomConnectors.skillContentBundleSourceVersionId,
      })
      .from(orgCustomConnectors)
      .where(
        eq(
          orgCustomConnectors.skillContentBundleSourceVersionId,
          orgCustomConnectors.skillStorageVersionId,
        ),
      );
  });
