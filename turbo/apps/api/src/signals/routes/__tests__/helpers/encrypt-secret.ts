import { createCipheriv, randomBytes } from "node:crypto";

const TEST_KMS_KEY_ID = "alias/okou-secrets-test";
const TEST_DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const STORED_SECRET_ENVELOPE_PREFIX = "vm0secret:v1:";

export function encryptSecretForTests(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", TEST_DATA_KEY, iv, {
    authTagLength: 16,
  });
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${STORED_SECRET_ENVELOPE_PREFIX}${Buffer.from(
    JSON.stringify({
      v: 1,
      kind: "stored-secret",
      kms: {
        keyId: TEST_KMS_KEY_ID,
        encryptedDataKey: Buffer.from(
          `encrypted-data-key:${TEST_KMS_KEY_ID}`,
          "utf8",
        ).toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        ciphertext: data.toString("base64"),
      },
    }),
    "utf8",
  ).toString("base64url")}`;
}
