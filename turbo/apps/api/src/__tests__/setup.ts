import "./external-setup";
import { beforeAll } from "vitest";
import { seedDevelopmentModelPricingForTests } from "../test-fixtures/usage-pricing";
import { installSharedApiTestConnectorCatalog } from "../test-fixtures/connector-catalog";

beforeAll(async () => {
  await seedDevelopmentModelPricingForTests();
  await installSharedApiTestConnectorCatalog();
});
