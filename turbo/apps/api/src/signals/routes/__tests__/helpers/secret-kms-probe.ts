import {
  setSecretKmsClientForTests,
  type SecretKmsClient,
  type SecretKmsDataKey,
  type SecretKmsDecryptRequest,
  type SecretKmsGenerateDataKeyRequest,
} from "../../../../lib/secret-kms-client";

const TEST_DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

interface SecretKmsProbe {
  readonly generateDataKeyCalls: number;
  readonly decryptCalls: number;
}

function generateDataKeyOutput(
  request: SecretKmsGenerateDataKeyRequest,
): SecretKmsDataKey {
  return {
    keyId: request.keyId,
    plaintext: TEST_DATA_KEY,
    encryptedDataKey: Buffer.from(
      `encrypted-data-key:${request.keyId}`,
      "utf8",
    ),
  };
}

export function useSecretKmsProbe(
  overrideGenerateDataKey?: (
    request: SecretKmsGenerateDataKeyRequest,
    callNumber: number,
    signal?: AbortSignal,
  ) => Promise<SecretKmsDataKey> | undefined,
  overrideDecrypt?: (
    request: SecretKmsDecryptRequest,
    callNumber: number,
  ) => Promise<Uint8Array> | undefined,
): SecretKmsProbe {
  let generateDataKeyCalls = 0;
  let decryptCalls = 0;

  const client: SecretKmsClient = {
    generateDataKey(
      request: SecretKmsGenerateDataKeyRequest,
      signal?: AbortSignal,
    ): Promise<SecretKmsDataKey> {
      generateDataKeyCalls += 1;
      const overridden = overrideGenerateDataKey?.(
        request,
        generateDataKeyCalls,
        signal,
      );
      return overridden ?? Promise.resolve(generateDataKeyOutput(request));
    },
    decrypt(request: SecretKmsDecryptRequest): Promise<Uint8Array> {
      decryptCalls += 1;
      const overridden = overrideDecrypt?.(request, decryptCalls);
      return overridden ?? Promise.resolve(TEST_DATA_KEY);
    },
  };

  setSecretKmsClientForTests(client);
  return {
    get generateDataKeyCalls() {
      return generateDataKeyCalls;
    },
    get decryptCalls() {
      return decryptCalls;
    },
  };
}
