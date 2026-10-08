import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";

import { singleton, testOverride } from "./singleton";

export interface SecretKmsGenerateDataKeyRequest {
  readonly keyId: string;
  readonly encryptionContext: Readonly<Record<string, string>>;
}

export interface SecretKmsDataKey {
  readonly keyId: string;
  readonly plaintext: Uint8Array;
  readonly encryptedDataKey: Uint8Array;
}

export interface SecretKmsDecryptRequest {
  readonly keyId: string;
  readonly ciphertext: Uint8Array;
  readonly encryptionContext: Readonly<Record<string, string>>;
}

/**
 * Narrow KMS surface. Callers never see `@aws-sdk/client-kms` types: this
 * module is the only api file that resolves them, which keeps the SDK's
 * declaration surface out of the core type-check program.
 */
export interface SecretKmsClient {
  generateDataKey(
    request: SecretKmsGenerateDataKeyRequest,
  ): Promise<SecretKmsDataKey>;
  decrypt(request: SecretKmsDecryptRequest): Promise<Uint8Array>;
}

const secretKmsClient = singleton((): SecretKmsClient => {
  const client = new KMSClient({});

  return {
    async generateDataKey(
      request: SecretKmsGenerateDataKeyRequest,
    ): Promise<SecretKmsDataKey> {
      const response = await client.send(
        new GenerateDataKeyCommand({
          KeyId: request.keyId,
          KeySpec: "AES_256",
          EncryptionContext: { ...request.encryptionContext },
        }),
      );
      if (!response.Plaintext) {
        throw new Error(
          "AWS KMS GenerateDataKey response did not include plaintext",
        );
      }
      if (!response.CiphertextBlob) {
        throw new Error(
          "AWS KMS GenerateDataKey response did not include encrypted data key",
        );
      }

      return {
        keyId: response.KeyId ?? request.keyId,
        plaintext: response.Plaintext,
        encryptedDataKey: response.CiphertextBlob,
      };
    },

    async decrypt(request: SecretKmsDecryptRequest): Promise<Uint8Array> {
      const response = await client.send(
        new DecryptCommand({
          KeyId: request.keyId,
          CiphertextBlob: request.ciphertext,
          EncryptionContext: { ...request.encryptionContext },
        }),
      );
      if (!response.Plaintext) {
        throw new Error("AWS KMS decrypt response did not include plaintext");
      }

      return response.Plaintext;
    },
  };
});

const testSecretKmsClient = testOverride<SecretKmsClient | undefined>(() => {
  return undefined;
});

export function getSecretKmsClient(): SecretKmsClient {
  return testSecretKmsClient.get() ?? secretKmsClient();
}

export function setSecretKmsClientForTests(
  client: SecretKmsClient | undefined,
): void {
  testSecretKmsClient.set(client);
}
