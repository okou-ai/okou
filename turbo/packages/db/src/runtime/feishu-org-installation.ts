import { pgTable } from "drizzle-orm/pg-core";
import { feishuOrgInstallationColumns } from "../columns/feishu-org-installation";

/** Excludes the retired agent default from implicit SELECT, INSERT and RETURNING. */
export const feishuOrgInstallations = pgTable(
  "feishu_org_installations",
  feishuOrgInstallationColumns(),
);
