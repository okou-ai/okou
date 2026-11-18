import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { and, eq, isNotNull, notExists, or } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

// Preserve the existing custom bot as the default when Official is also present.
// Official callers can always select their installation explicitly with --as.
export function defaultFeishuInstallationFilter(
  orgId: string,
  platform: FeishuPlatform,
) {
  const custom = alias(feishuOrgInstallations, "default_custom_feishu");
  return or(
    eq(feishuOrgInstallations.installationType, "custom"),
    notExists(
      new QueryBuilder()
        .select({ id: custom.id })
        .from(custom)
        .where(
          and(
            eq(custom.orgId, orgId),
            eq(custom.platform, platform),
            eq(custom.installationType, "custom"),
            isNotNull(custom.setupCompletedAt),
          ),
        ),
    ),
  );
}
