import { and, asc, eq, gt, ne } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import {
  renewErasureLease,
  type EncryptedErasureSelector,
  type ErasureHandler,
  type ErasureInventoryPage,
  type ErasureLease,
  type ErasureProof,
  type ErasureUnresolved,
} from "@okouai/db/operations/account-erasure";
import {
  browserProfiles,
  browserThreadProfiles,
} from "@okouai/db/schema/browser-session";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { safeJsonParse, settle } from "../utils";
import {
  browserUseProfileAbsent,
  BrowserUseProviderError,
  deleteBrowserUseProfile,
} from "./browser-use.service";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";

const NAMESPACE = "01c451ab-d92a-4a1d-90d5-c597022301da";
const PAGE_SIZE = 100;
const cursorSchema = z.tuple([z.number().int().min(0).max(1), z.uuid()]);
export const BROWSER_PROFILE_ERASURE_COLLECTOR_VERSION =
  "23607330-ceb6-4212-bfaa-80e9c77e2789";

type Cursor = readonly [number, string];
interface ProfileRow {
  readonly cursor: Cursor;
  readonly profileId: string;
}

function ref(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), NAMESPACE);
}

function unresolved(
  errorCode: NonNullable<ErasureUnresolved["errorCode"]>,
  outcome: ErasureUnresolved["outcome"] = "capability_unresolved",
): ErasureUnresolved {
  return { outcome, errorCode, requestRef: null };
}

async function subjectOf(lease: ErasureLease): Promise<string | undefined> {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  return selector.kind === "subject" && selector.subjectKind === "user"
    ? selector.subjectId
    : undefined;
}

async function profileOf(
  lease: ErasureLease,
): Promise<
  { readonly userId: string; readonly profileId: string } | undefined
> {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  return selector.kind === "provider" &&
    selector.resourceType === "browser_profile" &&
    selector.accountRef === ref(["browser-use", selector.subjectId])
    ? { userId: selector.subjectId, profileId: selector.resourceId }
    : undefined;
}

async function readPage(
  db: Db,
  userId: string,
  after?: Cursor,
): Promise<ProfileRow[]> {
  const rows: ProfileRow[] = [];
  if (!after || after[0] === 0) {
    const legacy = await db
      .select({
        id: browserProfiles.id,
        profileId: browserProfiles.providerProfileId,
      })
      .from(browserProfiles)
      .where(
        and(
          eq(browserProfiles.userId, userId),
          after ? gt(browserProfiles.id, after[1]) : undefined,
        ),
      )
      .orderBy(asc(browserProfiles.id))
      .limit(PAGE_SIZE);
    for (const row of legacy) {
      rows.push({ cursor: [0, row.id], profileId: row.profileId });
    }
  }
  if (rows.length < PAGE_SIZE) {
    const threads = await db
      .select({
        id: browserThreadProfiles.id,
        profileId: browserThreadProfiles.providerProfileId,
      })
      .from(browserThreadProfiles)
      .where(
        and(
          eq(browserThreadProfiles.userId, userId),
          after?.[0] === 1 ? gt(browserThreadProfiles.id, after[1]) : undefined,
        ),
      )
      .orderBy(asc(browserThreadProfiles.id))
      .limit(PAGE_SIZE - rows.length);
    for (const row of threads) {
      rows.push({ cursor: [1, row.id], profileId: row.profileId });
    }
  }
  return rows;
}

/** A legacy and a thread-scoped row may name the same provider profile.
 * Neither a surviving account's row nor an unverified provider response can
 * grant authority to delete that profile. */
async function otherOwnerReferences(
  db: Db,
  profileId: string,
  userId: string,
): Promise<boolean> {
  const [legacy] = await db
    .select({ id: browserProfiles.id })
    .from(browserProfiles)
    .where(
      and(
        eq(browserProfiles.providerProfileId, profileId),
        ne(browserProfiles.userId, userId),
      ),
    )
    .limit(1);
  if (legacy) {
    return true;
  }
  const [thread] = await db
    .select({ id: browserThreadProfiles.id })
    .from(browserThreadProfiles)
    .where(
      and(
        eq(browserThreadProfiles.providerProfileId, profileId),
        ne(browserThreadProfiles.userId, userId),
      ),
    )
    .limit(1);
  return thread !== undefined;
}

async function inventory(
  db: Db,
  lease: ErasureLease,
  cursor: EncryptedErasureSelector | null,
): Promise<ErasureInventoryPage | ErasureUnresolved> {
  const userId = await subjectOf(lease);
  if (!userId) {
    return unresolved("selector_missing");
  }
  await renewErasureLease(db, lease);
  let after: Cursor | undefined;
  if (cursor) {
    const decoded = await decryptErasureSelector(cursor);
    const parsed =
      decoded.kind === "cursor"
        ? cursorSchema.safeParse(safeJsonParse(decoded.after))
        : undefined;
    if (!parsed?.success) {
      return unresolved("selector_missing");
    }
    after = parsed.data;
  }
  const rows = await readPage(db, userId, after);
  for (const row of rows) {
    if (await otherOwnerReferences(db, row.profileId, userId)) {
      return unresolved("ownership_unknown");
    }
  }
  const items = await Promise.all(
    rows.map(async (row) => {
      return {
        sinkId: lease.item.sinkId,
        itemKey: ref(["browser-profile", row.cursor]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "provider",
          accountRef: ref(["browser-use", userId]),
          subjectId: userId,
          resourceType: "browser_profile",
          resourceId: row.profileId,
        }),
        dependencies: [],
      };
    }),
  );
  const last = rows.at(-1);
  return {
    pageKey: ref([
      "browser-profile-page",
      lease.jobId,
      lease.captureRevision,
      after ?? null,
    ]),
    inputCursorDigest: lease.item.cursorDigest,
    nextCursor:
      rows.length < PAGE_SIZE || !last
        ? null
        : await encryptErasureSelector({
            version: 1,
            kind: "cursor",
            after: JSON.stringify(last.cursor),
          }),
    enumerationRef:
      rows.length < PAGE_SIZE
        ? ref([
            "browser-profile-enumeration",
            userId,
            BROWSER_PROFILE_ERASURE_COLLECTOR_VERSION,
          ])
        : null,
    items,
  };
}

/** This narrow sink proves provider profile absence, not browser sessions or
 * other remote resources. The required `remote` sink remains unregistered until
 * those obligations have their own capture and terminal proof. */
export function createBrowserProfileErasureCollector(db: Db): ErasureHandler {
  return {
    version: BROWSER_PROFILE_ERASURE_COLLECTOR_VERSION,
    inventory: async (lease, cursor) => {
      return await inventory(db, lease, cursor);
    },
    erase: async (lease, signal) => {
      const profile = await profileOf(lease);
      if (!profile) {
        return unresolved("selector_missing");
      }
      await renewErasureLease(db, lease);
      if (await otherOwnerReferences(db, profile.profileId, profile.userId)) {
        return unresolved("ownership_unknown");
      }
      const deleted = await settle(
        deleteBrowserUseProfile(profile.profileId, signal),
        signal,
      );
      if (!deleted.ok) {
        if (!(deleted.error instanceof BrowserUseProviderError)) {
          throw deleted.error;
        }
        return unresolved("verification_failed", "retryable_failure");
      }
      return {
        requestRef: ref([
          "browser-profile-delete",
          lease.jobId,
          lease.item.itemKey,
        ]),
      };
    },
    verify: async (
      lease,
      boundary,
      signal,
    ): Promise<ErasureProof | ErasureUnresolved> => {
      const profile = await profileOf(lease);
      if (!profile && !(await subjectOf(lease))) {
        return unresolved("selector_missing");
      }
      if (profile) {
        if (await otherOwnerReferences(db, profile.profileId, profile.userId)) {
          return unresolved("ownership_unknown");
        }
        const absence = await settle(
          browserUseProfileAbsent(profile.profileId, signal),
          signal,
        );
        if (!absence.ok) {
          if (!(absence.error instanceof BrowserUseProviderError)) {
            throw absence.error;
          }
          return unresolved("verification_failed", "retryable_failure");
        }
        if (!absence.value) {
          return unresolved("verification_failed", "retryable_failure");
        }
      }
      return {
        workId: lease.workId,
        sinkId: lease.item.sinkId,
        generation: lease.generation,
        captureRevision: lease.captureRevision,
        inventoryRevision: lease.inventoryRevision,
        producerBoundaryRef: boundary,
        outcome: profile ? "verified_erased" : "verified_no_applicable_data",
        evidenceRef: ref([
          "browser-profile-absence",
          lease.jobId,
          lease.item.itemKey,
        ]),
        authenticatedReaderRef: ref(["browser-use", "profile-reader"]),
        enumerationRef: ref([
          "browser-profile-item-enumeration",
          lease.item.itemKey,
        ]),
        observedAt: nowDate(),
      };
    },
  };
}
