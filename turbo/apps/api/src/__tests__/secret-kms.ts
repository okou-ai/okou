import type {
  SecretKmsClient,
  SecretKmsDataKey,
  SecretKmsGenerateDataKeyRequest,
} from "../lib/secret-kms-client";

/** External KMS boundary shared by PostgreSQL and per-case PGlite suites. */
export function createApiTestKmsClient(): SecretKmsClient {
  const testDataKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
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
