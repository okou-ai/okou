import { randomUUID } from "node:crypto";
import type { OnboardingDraftPayload } from "@okouai/api-contracts/validators/onboarding";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { onboardingDrafts } from "@okouai/db/schema/onboarding-draft";
import { command } from "ccstate";
import { and, eq, gt, lte } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface DraftOwner {
  readonly orgId: string;
  readonly userId: string;
}

function draftOwner(owner: DraftOwner) {
  return and(
    eq(onboardingDrafts.orgId, owner.orgId),
    eq(onboardingDrafts.userId, owner.userId),
  );
}

export const serverOnboardingDraftEnabled$ = command(
  async ({ set }, owner: DraftOwner, signal: AbortSignal) => {
    const context = await set(
      loadUserFeatureSwitchContext$,
      owner.orgId,
      owner.userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.ServerOnboardingDraft, context);
  },
);

export const readOnboardingDraft$ = command(
  async ({ get }, owner: DraftOwner, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({
        payload: onboardingDrafts.payload,
        revision: onboardingDrafts.revision,
      })
      .from(onboardingDrafts)
      .where(and(draftOwner(owner), gt(onboardingDrafts.expiresAt, nowDate())))
      .limit(1);
    signal.throwIfAborted();
    return row ? { ...row.payload, revision: row.revision } : null;
  },
);

export const saveOnboardingDraft$ = command(
  async (
    { set },
    owner: DraftOwner,
    payload: OnboardingDraftPayload,
    expectedRevision: string | null,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const now = nowDate();
    const values = {
      payload,
      revision: randomUUID(),
      expiresAt: new Date(now.getTime() + DRAFT_TTL_MS),
    };
    signal.throwIfAborted();
    const written =
      expectedRevision === null
        ? await db
            .insert(onboardingDrafts)
            .values({ orgId: owner.orgId, userId: owner.userId, ...values })
            .onConflictDoUpdate({
              target: [onboardingDrafts.orgId, onboardingDrafts.userId],
              set: values,
              setWhere: lte(onboardingDrafts.expiresAt, now),
            })
            .returning({ revision: onboardingDrafts.revision })
        : await db
            .update(onboardingDrafts)
            .set(values)
            .where(
              and(
                draftOwner(owner),
                eq(onboardingDrafts.revision, expectedRevision),
                gt(onboardingDrafts.expiresAt, now),
              ),
            )
            .returning({ revision: onboardingDrafts.revision });
    return written[0] ?? null;
  },
);

export const deleteOnboardingDraft$ = command(
  async ({ set }, owner: DraftOwner) => {
    await set(writeDb$).delete(onboardingDrafts).where(draftOwner(owner));
  },
);

export const eraseOnboardingDrafts$ = command(
  async (
    { set },
    identity:
      | { readonly kind: "organization"; readonly orgId: string }
      | { readonly kind: "user"; readonly userId: string },
  ) => {
    await set(writeDb$)
      .delete(onboardingDrafts)
      .where(
        identity.kind === "organization"
          ? eq(onboardingDrafts.orgId, identity.orgId)
          : eq(onboardingDrafts.userId, identity.userId),
      );
  },
);

export const cleanupExpiredOnboardingDrafts$ = command(async ({ set }) => {
  await set(writeDb$)
    .delete(onboardingDrafts)
    .where(lte(onboardingDrafts.expiresAt, nowDate()));
});
