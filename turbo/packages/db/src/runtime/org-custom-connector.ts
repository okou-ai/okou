import { pgTable } from "drizzle-orm/pg-core";
import { orgCustomConnectorColumns } from "../columns/org-custom-connector";

export const orgCustomConnectors = pgTable(
  "org_custom_connectors",
  orgCustomConnectorColumns(),
);
