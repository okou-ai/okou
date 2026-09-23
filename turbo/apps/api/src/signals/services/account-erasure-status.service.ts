import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { accountErasureJobs } from "@okouai/db/schema/account-erasure";
import { backgroundJobs } from "@okouai/db/schema/background-job";

import { env } from "../../lib/env";
import type { ReadonlyDb } from "../external/db";
import { safeJsonParse } from "../utils";

const tokenPayloadSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string().min(1).max(192),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
});

// This read-only capability has no clock expiry: a Desktop partition may be
// dormant past the Clerk deletion, then reopen years later without a session.
// The credential reveals only that same account's deletion state.

function signingKey(): Buffer {
  const secret = env("SECRETS_ENCRYPTION_KEY");
  if (!/^[a-f0-9]{64}$/iu.test(secret)) {
    throw new Error("Account deletion status signing key is invalid");
  }
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update("account-erasure-status/v1")
    .digest();
}

function signature(encoded: string): Buffer {
  return createHmac("sha256", signingKey()).update(encoded).digest();
}

export function createAccountErasureStatusCapability(userId: string): {
  readonly token: string;
} {
  const payload = tokenPayloadSchema.parse({
    version: 1,
    userId,
    nonce: randomBytes(16).toString("base64url"),
  });
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    token: `v1.${encoded}.${signature(encoded).toString("base64url")}`,
  };
}

export function userIdFromAccountErasureStatusCapability(
  token: string,
): string | null {
  if (token.length > 512) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return null;
  }
  const encoded = parts[1];
  const encodedSignature = parts[2];
  if (
    !encoded ||
    !encodedSignature ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
    !/^[A-Za-z0-9_-]+$/u.test(encodedSignature)
  ) {
    return null;
  }
  const provided = Buffer.from(encodedSignature, "base64url");
  const expected = signature(encoded);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }
  const parsed = tokenPayloadSchema.safeParse(
    safeJsonParse(Buffer.from(encoded, "base64url").toString("utf8")),
  );
  if (!parsed.success) {
    return null;
  }
  return parsed.data.userId;
}

export async function accountErasureStatus(
  db: ReadonlyDb,
  userId: string,
): Promise<"active" | "pending" | "complete"> {
  const [job] = await db
    .select({ state: accountErasureJobs.state })
    .from(accountErasureJobs)
    .where(
      and(
        eq(accountErasureJobs.subjectKind, "user"),
        eq(accountErasureJobs.subjectId, userId),
      ),
    )
    .orderBy(desc(accountErasureJobs.generation))
    .limit(1);
  if (job) {
    return job.state === "verified_erased" ||
      job.state === "verified_no_applicable_data"
      ? "complete"
      : "pending";
  }
  const [task] = await db
    .select({ id: backgroundJobs.id })
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.kind, "clerk-user-deletion"),
        eq(backgroundJobs.userId, userId),
      ),
    )
    .limit(1);
  return task ? "pending" : "active";
}
