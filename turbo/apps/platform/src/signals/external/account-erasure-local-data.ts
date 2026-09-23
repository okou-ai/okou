import { command } from "ccstate";
import { deleteDB } from "idb";

import { clearSourcesFirstDraftForUser$ } from "../onboarding/onboarding-sources-first-state.ts";
import { clearOnboardingCheckoutDraftForUser$ } from "../onboarding/onboarding-state.ts";
import { deleteVoiceDraftRecordingsForUser } from "./voice-draft-store.ts";

const VOICE_DRAFT_DB = "okou-voice-drafts";
const CANONICAL_CHAT_DB_NAME =
  /^vm0-chat-(user_[A-Za-z0-9]+)-(org_[A-Za-z0-9]+)$/u;

/** Purge only the account named by a verified deletion-status response. */
export const deleteAccountLocalData$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const databases = await indexedDB.databases();
    signal.throwIfAborted();
    const names = databases.flatMap((database) => {
      return database.name ? [database.name] : [];
    });
    const candidateNames = names.filter((name) => {
      return name.startsWith(`vm0-chat-${userId}-`);
    });
    // The legacy database name uses a separator rather than encoded IDs.
    // Fail closed on an ambiguous name so a prefix collision cannot erase
    // another Clerk account's local cache.
    if (
      candidateNames.some((name) => {
        return CANONICAL_CHAT_DB_NAME.exec(name)?.[1] !== userId;
      })
    ) {
      throw new Error("Ambiguous account-scoped chat cache name");
    }
    for (const name of candidateNames) {
      await deleteDB(name);
      signal.throwIfAborted();
    }
    if (names.includes(VOICE_DRAFT_DB)) {
      await deleteVoiceDraftRecordingsForUser(userId);
      signal.throwIfAborted();
    }
    set(clearSourcesFirstDraftForUser$, userId);
    set(clearOnboardingCheckoutDraftForUser$, userId);
  },
);
