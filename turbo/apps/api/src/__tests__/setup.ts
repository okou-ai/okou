import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { resetApiTestMocks } from "./mocks";
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
import { clearAllDetached } from "../signals/utils";
import { withUsageEventCompactionScopeFixture } from "../test-fixtures/usage-event-compaction";
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
  await withUsageEventCompactionScopeFixture(randomUUID(), async () => {
    await withSecretKmsClientForTest(createApiTestKmsClient(), runTest);
  });
});

beforeAll(async () => {
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
  server.resetHandlers();
});

afterAll(() => {
  server.close();
  syncBuiltinESMExports();
});
