import { isNotNull } from "drizzle-orm";
import { pgView } from "drizzle-orm/pg-core";
import { orgCustomConnectors } from "./org-custom-connector";

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
      .where(isNotNull(orgCustomConnectors.skillContentBundleSourceVersionId));
  });
