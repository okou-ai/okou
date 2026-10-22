import { env } from "cloudflare:workers";
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";

export const client =
  env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION
    ? new KMSClient({
        region: env.AWS_REGION,
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
        maxAttempts: 1,
      })
    : undefined;

export function getSecretKmsClient() {
  if (!client) throw new Error("Dedicated KMS credentials are not configured");
  return {
    async generateDataKey({ keyId, encryptionContext }) {
      const response = await client.send(
        new GenerateDataKeyCommand({
          KeyId: keyId,
          KeySpec: "AES_256",
          EncryptionContext: encryptionContext,
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      if (!response.Plaintext || !response.CiphertextBlob) {
        throw new Error("Incomplete GenerateDataKey response");
      }
      return {
        keyId: response.KeyId,
        plaintext: response.Plaintext,
        encryptedDataKey: response.CiphertextBlob,
      };
    },
    async decrypt({ keyId, ciphertext, encryptionContext }) {
      const response = await client.send(
        new DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: ciphertext,
          EncryptionContext: encryptionContext,
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      if (!response.Plaintext) throw new Error("Incomplete Decrypt response");
      return response.Plaintext;
    },
  };
}
