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
    kind: z.literal("object_batch"),
    storageRef: z.uuid(),
    keys: z.array(z.string().min(1).max(2048)).min(1).max(20),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("export_object"),
    storageRef: z.uuid(),
    subjectId: z.string().min(1).max(192),
    jobId: z.uuid(),
    resultKey: z.string().min(1).max(2048),
    stagingPrefix: z.string().min(1).max(2048),
    legacyKey: z.string().min(1).max(2048).optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("artifact_share"),
    storageRef: z.uuid(),
    shareId: z.uuid(),
    targetKind: z.enum(["file", "html"]),
    targetId: z.uuid(),
    publicBrand: z.enum(["vm0", "okou"]),
    keys: z.array(z.string().min(1).max(2048)).min(1).max(4),
    privateKey: z.string().min(1).max(2048).optional(),
    snapshotPrefix: z.string().min(1).max(2048).optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("artifact_share_history"),
    shareId: z.uuid(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("shared_blob"),
    subjectId: z.string().min(1).max(192),
    hash: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  // A resource whose bytes are owned by a key prefix rather than by a listed
  // set of keys. A hosted deployment is the case: its manifest names the files
  // it uploaded, but the prefix owns everything under it, so capturing the
  // prefix reaches an object the manifest never listed. Capturing the prefix
  // is also what survives the catalog row, which is the point — the row that
  // holds `r2_prefix` is deleted by the relational sweep.
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("object_prefix"),
    storageRef: z.uuid(),
    prefix: z.string().min(1).max(2048),
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
