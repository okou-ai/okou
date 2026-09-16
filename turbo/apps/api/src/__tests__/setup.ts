import { syncBuiltinESMExports } from "node:module";
import { resetApiTestMocks } from "./mocks";
import { clerkUsersHandler } from "./clerk-users-handler";
import { afterAll, afterEach, aroundEach, beforeAll, beforeEach } from "vitest";

import { clearMockedEnv, mockEnv } from "../lib/env";
import {
  type SecretKmsClient,
  type SecretKmsDataKey,
  type SecretKmsGenerateDataKeyRequest,
  withSecretKmsClientForTest,
} from "../lib/secret-kms-client";
import { clearMockNow } from "../lib/time";
import { server } from "../mocks/server";
import { handlers } from "../mocks/handlers/index";
import { clearAllDetached } from "../signals/utils";
import {
  installApiTestConnectorCatalog,
  mockApiTestConnectorProviderConfiguration,
} from "../test-fixtures/connector-catalog";

const testDataKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function createApiTestKmsClient(): SecretKmsClient {
  return {
    generateDataKey(
      request: SecretKmsGenerateDataKeyRequest,
    ): Promise<SecretKmsDataKey> {
      return Promise.resolve({
        keyId: request.keyId,
        plaintext: testDataKey,
        encryptedDataKey: Buffer.from(
          `encrypted-data-key:${request.keyId}`,
          "utf8",
        ),
      });
    },
    decrypt(): Promise<Uint8Array> {
      return Promise.resolve(testDataKey);
    },
  };
}

aroundEach(async (runTest) => {
  await withSecretKmsClientForTest(createApiTestKmsClient(), runTest);
});

beforeAll(async () => {
  server.resetHandlers(clerkUsersHandler, ...handlers);
  mockApiTestConnectorProviderConfiguration();
  await installApiTestConnectorCatalog();
  server.listen({ onUnhandledRequest: "error" });
  // SDK transports can import named HTTP exports instead of the CJS module.
  syncBuiltinESMExports();
});

beforeEach(() => {
  mockApiTestConnectorProviderConfiguration();
  mockEnv("SECRETS_KMS_KEY_ID", "alias/okou-secrets-test");
});

afterEach(async () => {
  await clearAllDetached();
  clearMockNow();
  clearMockedEnv();
  resetApiTestMocks();
  server.resetHandlers(clerkUsersHandler, ...handlers);
});

afterAll(() => {
  server.close();
  syncBuiltinESMExports();
});
