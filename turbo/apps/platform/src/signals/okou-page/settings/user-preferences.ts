import { command, computed, state } from "ccstate";
import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
} from "@okouai/api-contracts/contracts/user-preferences";
import { apiClient$ } from "../../api-client.ts";
import { clerk$ } from "../../auth.ts";
import {
  initializeMorningBriefEnrollment$,
  retryMorningBriefPreference$,
} from "./morning-brief-preference.ts";
import { accept } from "../../../lib/accept.ts";

// ---------------------------------------------------------------------------
// Reload trigger
// ---------------------------------------------------------------------------

const internalReloadPreferences$ = state(0);

const reloadUserPreferences$ = command(({ set }) => {
  set(internalReloadPreferences$, (x) => {
    return x + 1;
  });
});

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export const userPreferences$ = computed(async (get) => {
  get(internalReloadPreferences$);
  const createClient = get(apiClient$);
  const client = createClient(userPreferencesContract);
  const result = await accept(client.get(), [200]);
  return result.body;
});

// ---------------------------------------------------------------------------
// Update command
// ---------------------------------------------------------------------------

export const updateUserPreference$ = command(
  async (
    { get, set },
    update: UpdateUserPreferencesRequest,
    signal: AbortSignal,
  ) => {
    const createClient = get(apiClient$);
    const client = createClient(userPreferencesContract);
    await accept(
      client.update({
        body: update,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    // Force JWT refresh so updated membership metadata is available immediately
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await clerk.session?.getToken({ skipCache: true });
    signal.throwIfAborted();

    set(reloadUserPreferences$);
    if (update.timezone !== undefined) {
      set(retryMorningBriefPreference$);
    }
  },
);

export const initializeUserTimezone$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    await set(
      initializeMorningBriefEnrollment$,
      timezone ? { timezone } : {},
      signal,
    );
    signal.throwIfAborted();
    set(reloadUserPreferences$);
  },
);
