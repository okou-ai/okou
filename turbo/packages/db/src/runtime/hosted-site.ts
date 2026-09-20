import { pgTable } from "drizzle-orm/pg-core";
import {
  hostedDeploymentColumns,
  hostedSiteColumns,
  privateHostedDeploymentColumns,
} from "../columns/hosted-site";

// Runtime queries and physical DDL share these column factories. Index
// definitions live in the physical schema used by migration generation.
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
