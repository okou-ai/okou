import { syncBuiltinESMExports } from "node:module";
import { resetApiTestMocks } from "./mocks";
import { afterAll, afterEach, aroundEach, beforeAll, beforeEach } from "vitest";

import { clearMockedEnv, mockEnv } from "../lib/env";
import { withSecretKmsClientForTest } from "../lib/secret-kms-client";
import { createApiTestKmsClient } from "./secret-kms";
import { clearMockNow } from "../lib/time";
import { server } from "../mocks/server";
import { clearAllDetached } from "../signals/utils";
import { seedDevelopmentModelPricingForTests } from "../test-fixtures/usage-pricing";
import {
  API_TEST_CONNECTOR_CATALOG_SOURCE,
  installSharedApiTestConnectorCatalog,
  mockApiTestConnectorProviderConfiguration,
} from "../test-fixtures/connector-catalog";

aroundEach(async (runTest) => {
  await withSecretKmsClientForTest(createApiTestKmsClient(), runTest);
});

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  // SDK transports can import named HTTP exports instead of the CJS module.
  syncBuiltinESMExports();
  await seedDevelopmentModelPricingForTests();
  mockApiTestConnectorProviderConfiguration();
  await installSharedApiTestConnectorCatalog();
});

beforeEach(() => {
  // Ordinary business tests share this source. Legacy lifecycle cases may
  // select their own source inside the case until those mechanisms retire.
  mockEnv(
    "R2_USER_STORAGES_BUCKET_NAME",
    API_TEST_CONNECTOR_CATALOG_SOURCE.bucket,
  );
  mockEnv("SECRETS_KMS_KEY_ID", "alias/okou-secrets-test");
  mockApiTestConnectorProviderConfiguration();
});

afterEach(async () => {
  await clearAllDetached();
  clearMockNow();
  clearMockedEnv();
  resetApiTestMocks();
  server.resetHandlers();
});

afterAll(() => {
  server.close();
  syncBuiltinESMExports();
});
