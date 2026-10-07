import { syncBuiltinESMExports } from "node:module";
import { resetApiTestMocks } from "./mocks";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

import { clearMockedEnv, mockEnv } from "../lib/env";
import { setSecretKmsClientForTests } from "../lib/secret-kms-client";
import { createApiTestKmsClient } from "./secret-kms";
import { clearMockNow } from "../lib/time";
import { server } from "../mocks/server";
import { clearAllDetached } from "../signals/utils";
import {
  API_TEST_CONNECTOR_CATALOG_SOURCE,
  mockApiTestConnectorProviderConfiguration,
} from "../test-fixtures/connector-catalog";

// Install the same defaults for the first case as afterEach installs thereafter.
resetApiTestMocks();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  // SDK transports can import named HTTP exports instead of the CJS module.
  syncBuiltinESMExports();
  mockApiTestConnectorProviderConfiguration();
});

beforeEach(() => {
  setSecretKmsClientForTests(createApiTestKmsClient());
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
  setSecretKmsClientForTests(undefined);
  server.close();
  syncBuiltinESMExports();
});
