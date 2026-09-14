import { createHash } from "node:crypto";
import type { EncryptedErasureSelector } from "@okouai/db/operations/account-erasure";
import { z } from "zod";

import { safeJsonParse } from "../utils";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";

const selectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("subject"),
    subjectKind: z.enum(["user", "organization"]),
    subjectId: z.string().min(1).max(192),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("object"),
    storageRef: z.uuid(),
    key: z.string().min(1).max(2048),
    versionId: z.string().min(1).max(256).optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("provider"),
    accountRef: z.uuid(),
    resourceType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    resourceId: z.string().min(1).max(512),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("row"),
    relation: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    id: z.uuid(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("cursor"),
    after: z.string().min(1).max(2048),
  }),
]);

function validatedSelector(input: unknown): z.infer<typeof selectorSchema> {
  const parsed = selectorSchema.safeParse(input);
  if (
    !parsed.success ||
    Buffer.byteLength(JSON.stringify(parsed.data)) > 4096
  ) {
    // Do not echo rejected input, provider responses, or Zod diagnostics.
    throw new Error("account_erasure:invalid_selector");
  }
  return parsed.data;
}

/** Prepare before entering the capture transaction: this may call KMS. */
export async function encryptErasureSelector(
  input: unknown,
): Promise<EncryptedErasureSelector> {
  const plaintext = JSON.stringify(validatedSelector(input));
  return {
    ciphertext: await encryptPersistentSecretValue(plaintext, {}),
    digest: createHash("sha256").update(plaintext).digest("hex"),
  };
}

/** Internal worker/restore use only; never mount as an account status API. */
export async function decryptErasureSelector(
  input: EncryptedErasureSelector,
): Promise<z.infer<typeof selectorSchema>> {
  const plaintext = await decryptPersistentSecretValue(input.ciphertext, {});
  if (createHash("sha256").update(plaintext).digest("hex") !== input.digest) {
    throw new Error("account_erasure:selector_digest_mismatch");
  }
  const parsed = safeJsonParse(plaintext);
  return validatedSelector(parsed);
}
