import { createHmac, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createErasureJournal } from "@okouai/db/erasure-journal";
import {
  createClerkErasureBridge,
  type ErasureBridgeAuthority,
} from "../../src/signals/services/account-erasure-bridge";

export const secret = `whsec_${Buffer.from("synthetic-clerk-erasure-secret-only").toString("base64")}`;
export const audience = "ins_synthetic_erasure_bridge";
export const requestedAt = 1_577_836_800_123;
export function event(overrides: Record<string, unknown> = {}) {
  return {
    object: "event",
    type: "user.deleted",
    instance_id: audience,
    timestamp: requestedAt,
    data: { id: `synthetic_${randomUUID()}`, deleted: true },
    ...overrides,
  };
}
export function request(
  body: unknown,
  eventId: string = randomUUID(),
  offsetSeconds = 0,
) {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) + offsetSeconds);
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${eventId}.${timestamp}.${text}`)
    .digest("base64");
  return new Request("https://synthetic.invalid/internal-unregistered", {
    method: "POST",
    body: text,
    headers: {
      "svix-id": eventId,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
  });
}
export function authority(version = 1): ErasureBridgeAuthority {
  return {
    decideInitial: () => {
      return Promise.resolve({
        outcome: "initial",
        generation: 1,
        dispositionVersion: version,
        deadlineAt: new Date(
          version === 1
            ? "2090-01-01T00:00:00.456Z"
            : "2099-01-01T00:00:00.789Z",
        ),
      });
    },
    applicability: (decision) => {
      return Promise.resolve({
        outcome: "applicable",
        decisionRef: decision.decisionRef,
      });
    },
  };
}
export function fixture(
  applicationUrl: string,
  controlUrl: string,
  authorityId: string,
  policy = authority(),
) {
  const pool = new Pool({
    connectionString: applicationUrl,
    options: "-c lock_timeout=1000 -c statement_timeout=10000",
  });
  const db = drizzle(pool);
  const journal = createErasureJournal(controlUrl, authorityId);
  const bridge = createClerkErasureBridge({
    db,
    journal,
    authorityId,
    audience,
    signingSecret: secret,
    authority: policy,
  });
  return {
    pool,
    db,
    journal,
    bridge,
    close: async () => {
      await pool.end();
      await journal.close();
    },
  };
}
