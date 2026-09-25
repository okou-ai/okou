import { command, computed, state } from "ccstate";
import { DEFAULT_USER_TIMEZONE, isValidTimeZone } from "@okouai/core/timezone";
import {
  userPreferencesContract,
  type InitializedUserPreferencesResponse,
  type UpdateUserPreferencesRequest,
} from "@okouai/api-contracts/contracts/user-preferences";
import { apiClient$ } from "../../api-client.ts";
import { resolveInitialLocaleFallbackFromBrowser } from "../../../i18n/locale-fallback.ts";
import { isSupportedLocale } from "../../../i18n/resources.ts";
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

function initialLocale() {
  // initLocale$ has already selected a usable locale before authenticated
  // bootstrap; it may have fallen back after a resource load failure.
  const locale = document.documentElement.lang;
  return isSupportedLocale(locale)
    ? locale
    : resolveInitialLocaleFallbackFromBrowser();
}

export const userPreferences$ = computed(
  async (get): Promise<InitializedUserPreferencesResponse> => {
    get(internalReloadPreferences$);
    const createClient = get(apiClient$);
    const client = createClient(userPreferencesContract);
    const result = await accept(client.get(), [200, 409]);
    if (result.status === 200) {
      if (
        result.body.timezone === null ||
        !isValidTimeZone(result.body.timezone) ||
        result.body.locale === null
      ) {
        throw new Error("Preferences returned an uninitialized state");
      }
      return {
        ...result.body,
        timezone: result.body.timezone,
        locale: result.body.locale,
      };
    }
    const locale = initialLocale();
    const initialized = await accept(
      client.initialize({
        body: {
          timezone: initialTimezone(),
          locale,
        },
      }),
      [200],
    );
    if (
      initialized.body.timezone === null ||
      !isValidTimeZone(initialized.body.timezone) ||
      initialized.body.locale === null
    ) {
      throw new Error("Initialization returned invalid preferences");
    }
    return {
      ...initialized.body,
      timezone: initialized.body.timezone,
      locale: initialized.body.locale,
    };
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
  },
);
