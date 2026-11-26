/**
 * Identity hashing — FNV-1a 32-bit hash used to reference users / orgs / emails
 * without embedding plain-text identifiers in source code.
 *
 * Shared between the feature-switch registry (UI rollout targeting) and
 * `staff-org.ts` (authorization primitive). The hash is deterministic and
 * synchronous; no crypto API needed.
 */

export function fnv1a(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Hashes of internal staff org IDs.
 *
 * This list is the source of truth for `isStaffOrg()` — adding an entry here
 * grants that org access to every endpoint that uses `isStaffOrg` as an
 * authorization check. Treat changes with the same care as role grants.
 */
export const STAFF_ORG_ID_FINGERPRINTS = [
  {
    // org_3ANttyrbWYJk6JKRSTRLEsbsDLe
    hash: "afce210e",
    sha256: "715f6d0777ccb8a9963fa3369a2fb53628408f0895c556b5fd2566fb350581b5",
  },
] as const;

export const STAFF_ORG_ID_HASHES: readonly string[] =
  STAFF_ORG_ID_FINGERPRINTS.map(({ hash }) => {
    return hash;
  });
