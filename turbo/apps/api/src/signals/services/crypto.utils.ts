import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { z } from "zod";

import { env } from "../../lib/env";
import { getSecretKmsClient } from "../../lib/secret-kms-client";

const secretsMapSchema = z.record(z.string(), z.string());
const STORED_SECRET_ENVELOPE_PREFIX = "vm0secret:v1:";

const directKmsCiphertextSchema = z.object({
  keyId: z.string().min(1),
  ciphertext: z.string().min(1),
});

const envelopeKmsCiphertextSchema = z.object({
  keyId: z.string().min(1),
  encryptedDataKey: z.string().min(1),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  ciphertext: z.string(),
});

const kmsCiphertextSchema = z.union([
  envelopeKmsCiphertextSchema,
  directKmsCiphertextSchema,
]);

const storedSecretEnvelopeSchema = z.object({
  v: z.literal(1),
  kind: z.literal("stored-secret"),
  kms: kmsCiphertextSchema,
});

type KmsCiphertext = z.infer<typeof kmsCiphertextSchema>;
type StoredSecretEnvelope = z.infer<typeof storedSecretEnvelopeSchema>;

const KMS_ENCRYPTION_CONTEXT = {
  purpose: "vm0-stored-secret",
} as const;
const DATA_KEY_BYTE_LENGTH = 32;

function requireSecretsKmsKeyId(): string {
  const keyId = env("SECRETS_KMS_KEY_ID");
  if (!keyId) {
    throw new Error("SECRETS_KMS_KEY_ID is required for KMS secret encryption");
  }
  return keyId;
}

function encodeStoredSecretEnvelope(envelope: StoredSecretEnvelope): string {
  return `${STORED_SECRET_ENVELOPE_PREFIX}${Buffer.from(
    JSON.stringify(envelope),
    "utf8",
  ).toString("base64url")}`;
}

function decodeStoredSecretEnvelope(encrypted: string): StoredSecretEnvelope {
  if (!encrypted.startsWith(STORED_SECRET_ENVELOPE_PREFIX)) {
    throw new Error("Stored secret ciphertext does not include KMS data");
  }

  const payload = encrypted.slice(STORED_SECRET_ENVELOPE_PREFIX.length);
  return storedSecretEnvelopeSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown,
  );
}

function encryptSecretValueWithDataKey(
  plaintext: string,
  key: Buffer,
): {
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: data.toString("base64"),
  };
}

function decryptSecretValueWithDataKey(
  ciphertext: z.infer<typeof envelopeKmsCiphertextSchema>,
  key: Buffer,
): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ciphertext.iv, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(ciphertext.authTag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext.ciphertext, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

async function encryptSecretValueWithKms(
  plaintext: string,
): Promise<KmsCiphertext> {
  const keyId = requireSecretsKmsKeyId();
  const dataKey = await getSecretKmsClient().generateDataKey({
    keyId,
    encryptionContext: KMS_ENCRYPTION_CONTEXT,
  });

  const plaintextDataKey = Buffer.from(dataKey.plaintext);
  if (plaintextDataKey.byteLength !== DATA_KEY_BYTE_LENGTH) {
    throw new Error(
      "AWS KMS GenerateDataKey response used an invalid key size",
    );
  }

  const encrypted = encryptSecretValueWithDataKey(plaintext, plaintextDataKey);
  plaintextDataKey.fill(0);
  return {
    keyId: dataKey.keyId,
    encryptedDataKey: Buffer.from(dataKey.encryptedDataKey).toString("base64"),
    ...encrypted,
  };
}

async function decryptSecretValueWithKms(
  ciphertext: KmsCiphertext,
): Promise<string> {
  if (!("encryptedDataKey" in ciphertext)) {
    const decrypted = await getSecretKmsClient().decrypt({
      keyId: ciphertext.keyId,
      ciphertext: Buffer.from(ciphertext.ciphertext, "base64"),
      encryptionContext: KMS_ENCRYPTION_CONTEXT,
    });

    return Buffer.from(decrypted).toString("utf8");
  }

  const decryptedDataKey = await getSecretKmsClient().decrypt({
    keyId: ciphertext.keyId,
    ciphertext: Buffer.from(ciphertext.encryptedDataKey, "base64"),
    encryptionContext: KMS_ENCRYPTION_CONTEXT,
  });

  const plaintextDataKey = Buffer.from(decryptedDataKey);
  if (plaintextDataKey.byteLength !== DATA_KEY_BYTE_LENGTH) {
    throw new Error("AWS KMS decrypt response used an invalid key size");
  }

  const plaintext = decryptSecretValueWithDataKey(ciphertext, plaintextDataKey);
  plaintextDataKey.fill(0);
  return plaintext;
}

export async function encryptStoredSecretValue(
  plaintext: string,
  _ctx: FeatureSwitchContext = {},
): Promise<string> {
  const kms = await encryptSecretValueWithKms(plaintext);
  return encodeStoredSecretEnvelope({
    v: 1,
    kind: "stored-secret",
    kms,
  });
}

export async function decryptStoredSecretValue(
  encrypted: string,
  _ctx: FeatureSwitchContext = {},
): Promise<string> {
  const envelope = decodeStoredSecretEnvelope(encrypted);
  return await decryptSecretValueWithKms(envelope.kms);
}

export async function encryptPersistentSecretValue(
  plaintext: string,
  ctx: FeatureSwitchContext,
): Promise<string> {
  return await encryptStoredSecretValue(plaintext, ctx);
}

export async function decryptPersistentSecretValue(
  encrypted: string,
  ctx: FeatureSwitchContext,
): Promise<string> {
  return await decryptStoredSecretValue(encrypted, ctx);
}

export async function decryptPersistentSecretsMap(
  encryptedData: string | null,
  ctx: FeatureSwitchContext,
): Promise<Record<string, string> | null> {
  if (!encryptedData) {
    return null;
  }

  return secretsMapSchema.parse(
    JSON.parse(
      await decryptPersistentSecretValue(encryptedData, ctx),
    ) as unknown,
  );
}

/**
 * Encrypt a single secret value using AES-256-GCM.
 *
 * Reads `SECRETS_ENCRYPTION_KEY` from env so call sites stay clean — symmetric
 * counterpart to `decryptSecretValue` below. Output format
 * `iv:authTag:ciphertext` (all base64) matches what `encryptSecretForTests`
 * already produces, so encrypt/decrypt round-trip is provably consistent.
 */
export function encryptSecretValue(plaintext: string): string {
  const key = Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    data.toString("base64"),
  ].join(":");
}

export function decryptSecretValue(encrypted: string): string {
  const key = Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex");
  const [ivBase64, authTagBase64, dataBase64] = encrypted.split(":");
  if (!ivBase64 || !authTagBase64 || !dataBase64) {
    throw new Error("Invalid encrypted data format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivBase64, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataBase64, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
