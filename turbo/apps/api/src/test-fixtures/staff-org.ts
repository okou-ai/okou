import { randomUUID } from "node:crypto";

import { STAFF_ORG_ID_HASHES } from "@okouai/core/identity-hash";

import { identityHashCollisionSuffix } from "./identity-hash-collision";

const COLLISION_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Creates a unique organization that exercises the production staff hash gate
 * without using a production organization identity.
 */
export function createUniqueStaffOrgIdFixture(): string {
  const targetHashHex = STAFF_ORG_ID_HASHES[0];
  if (!targetHashHex) {
    throw new Error("Expected at least one configured staff organization hash");
  }
  const targetHash = Number.parseInt(targetHashHex, 16);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const prefix = `org_${randomUUID()}_`;
    const suffix = identityHashCollisionSuffix({
      prefix,
      targetHash,
      alphabet: COLLISION_ALPHABET,
      rightLength: 3,
    });
    if (suffix) {
      return `${prefix}${suffix}`;
    }
  }
  throw new Error("Failed to generate a unique staff organization fixture");
}
