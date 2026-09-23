import { command, computed, state } from "ccstate";
import { DEFAULT_USER_TIMEZONE, isValidTimeZone } from "@okouai/core/timezone";
import {
  userPreferencesContract,
  type InitializedUserPreferencesResponse,
  type UpdateUserPreferencesRequest,
} from "@okouai/api-contracts/contracts/user-preferences";
import { apiClient$ } from "../../api-client.ts";
import { retryMorningBriefPreference$ } from "./morning-brief-preference.ts";
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

function initialTimezone(): string {
  const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone && isValidTimeZone(timezone)
    ? timezone
    : DEFAULT_USER_TIMEZONE;
}

export const userPreferences$ = computed(
  async (get): Promise<InitializedUserPreferencesResponse> => {
    get(internalReloadPreferences$);
    const createClient = get(apiClient$);
    const client = createClient(userPreferencesContract);
    const result = await accept(client.get(), [200, 409]);
    // A previous API version returns 200 with a null timezone during rollout.
    if (
      result.status === 200 &&
      result.body.timezone !== null &&
      isValidTimeZone(result.body.timezone)
    ) {
      return { ...result.body, timezone: result.body.timezone };
    }
    const initialized = await accept(
      client.initialize({ body: { timezone: initialTimezone() } }),
      [200],
    );
    if (
      initialized.body.timezone === null ||
      !isValidTimeZone(initialized.body.timezone)
    ) {
      throw new Error("Timezone initialization returned invalid preferences");
    }
    return { ...initialized.body, timezone: initialized.body.timezone };
  },
);

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

    set(reloadUserPreferences$);
    if (update.timezone !== undefined) {
      set(retryMorningBriefPreference$);
    }
  },
);
