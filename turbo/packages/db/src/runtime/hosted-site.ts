import { pgTable } from "drizzle-orm/pg-core";
import {
  hostedDeploymentColumns,
  hostedSiteColumns,
  privateHostedDeploymentColumns,
} from "../columns/hosted-site";

// Application statements omit the retired version columns. The physical
// mapping retains them until the preceding API leaves serving and rollback;
// follow-up #35240.
export const hostedSites = pgTable("hosted_sites", hostedSiteColumns());
export const hostedDeployments = pgTable(
  "hosted_deployments",
  hostedDeploymentColumns(() => {
    return hostedSites.id;
  }),
);
export const privateHostedDeployments = pgTable(
  "private_hosted_deployments",
  privateHostedDeploymentColumns(() => {
    return hostedSites.id;
  }),
);
