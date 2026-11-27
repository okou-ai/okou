import { command, computed, state } from "ccstate";
import { DEFAULT_USER_TIMEZONE, isValidTimeZone } from "@okouai/core/timezone";
import { userPreferencesContract } from "@okouai/api-contracts/client/user-preferences";
import type {
  InitializedUserPreferencesResponse,
  UpdateUserPreferencesRequest,
  UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import { resolveInitialLocaleFallbackFromBrowser } from "../../../i18n/locale-fallback.ts";
import { isSupportedLocale } from "../../../i18n/resources.ts";
import { accept } from "../../../lib/accept.ts";
import { featureSwitches$ } from "../../external/feature-switch.ts";

interface ConfirmedPreferences {
  readonly client: ApiClientFactory;
  readonly initialRead: Promise<InitializedUserPreferencesResponse>;
  readonly fields: Partial<InitializedUserPreferencesResponse>;
}

interface PendingPreferenceSaves {
  readonly client: ApiClientFactory;
  readonly writes: readonly ReadonlySet<string>[];
  readonly reconcile: boolean;
}

const confirmedPreferences$ = state<ConfirmedPreferences | null>(null);
const pendingPreferenceSaves$ = state<PendingPreferenceSaves | null>(null);
const preferenceReadRevision$ = state(0);

function initialTimezone(): string {
  const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone && isValidTimeZone(timezone)
    ? timezone
    : DEFAULT_USER_TIMEZONE;
}

function initialLocale() {
  // initLocale$ has already loaded the initial locale before authenticated
  // bootstrap initializes the workspace preference.
  const locale = document.documentElement.lang;
  return isSupportedLocale(locale)
    ? locale
    : resolveInitialLocaleFallbackFromBrowser();
}

const initialUserPreferences$ = computed(
  async (get): Promise<InitializedUserPreferencesResponse> => {
    get(preferenceReadRevision$);
    const createClient = get(apiClient$);
    const client = createClient(userPreferencesContract);
    await get(featureSwitches$);
    const result = await accept(client.get(), [200, 409]);
    // Initialization is idempotent: it fills missing timezone and locale and
    // creates the member's memory, which run creation requires.
    if (result.status === 200 && result.body.memoryInitialized) {
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

export const userPreferences$ = computed(async (get) => {
  const client = get(apiClient$);
  const confirmed = get(confirmedPreferences$);
  const initialRead = get(initialUserPreferences$);
  const initial = await initialRead;
  return confirmed?.client === client && confirmed.initialRead === initialRead
    ? { ...initial, ...confirmed.fields }
    : initial;
});

function confirmedFields(
  update: UpdateUserPreferencesRequest,
  result: UserPreferencesResponse,
): Partial<InitializedUserPreferencesResponse> {
  const timezone = update.timezone === undefined ? undefined : result.timezone;
  const locale = update.locale === undefined ? undefined : result.locale;
  if (timezone === null || locale === null) {
    throw new Error("Preference write response omitted a written value");
  }
  if (
    update.presentationFormat !== undefined &&
    result.presentationFormat !== update.presentationFormat
  ) {
    throw new Error("Presentation format write was not confirmed");
  }
  // Other fields in the response may come from a pre-write snapshot.
  return {
    ...(timezone !== undefined && { timezone }),
    ...(locale !== undefined && { locale }),
    ...(update.sendMode !== undefined && { sendMode: result.sendMode }),
    ...(update.cloudBrowserEnabledByDefault !== undefined && {
      cloudBrowserEnabledByDefault: result.cloudBrowserEnabledByDefault,
    }),
    ...(update.theme !== undefined && { theme: result.theme }),
    ...(update.colorTheme !== undefined && { colorTheme: result.colorTheme }),
    ...(update.presentationFormat !== undefined && {
      presentationFormat: result.presentationFormat,
    }),
    ...(update.forYouCoverId !== undefined && {
      forYouCoverId: result.forYouCoverId,
    }),
    ...(update.captureNetworkBodiesRemaining !== undefined && {
      captureNetworkBodiesRemaining: result.captureNetworkBodiesRemaining,
    }),
  };
}

export const updateUserPreference$ = command(
  async (
    { get, set },
    update: UpdateUserPreferencesRequest,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const createClient = get(apiClient$);
    const initialRead = get(initialUserPreferences$);
    const client = createClient(userPreferencesContract);
    const fields = Object.entries(update).flatMap(([key, value]) => {
      return value === undefined ? [] : [key];
    });
    const write = new Set(fields);
    const pending = get(pendingPreferenceSaves$);
    const scoped = pending?.client === createClient ? pending : null;
    const writes = scoped?.writes ?? [];
    set(pendingPreferenceSaves$, {
      client: createClient,
      writes: [...writes, write],
      reconcile:
        Boolean(scoped?.reconcile) ||
        writes.some((other) => {
          return fields.some((field) => {
            return other.has(field);
          });
        }),
    });

    const save = (async () => {
      const saved = await accept(
        client.update({
          body: update,
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      const confirmed = confirmedFields(update, saved.body);
      if (
        get(apiClient$) === createClient &&
        get(initialUserPreferences$) === initialRead
      ) {
        const previous = get(confirmedPreferences$);
        set(confirmedPreferences$, {
          client: createClient,
          initialRead,
          fields: {
            ...(previous?.client === createClient &&
            previous.initialRead === initialRead
              ? previous.fields
              : {}),
            ...confirmed,
          },
        });
      }
    })();
    await save.finally(() => {
      const current = get(pendingPreferenceSaves$);
      if (current?.client === createClient) {
        const remaining = current.writes.filter((entry) => {
          return entry !== write;
        });
        const reconcile =
          current.reconcile || get(initialUserPreferences$) !== initialRead;
        if (remaining.length > 0) {
          set(pendingPreferenceSaves$, {
            ...current,
            writes: remaining,
            reconcile,
          });
        } else {
          set(pendingPreferenceSaves$, null);
          // A refreshed baseline or competing commits need one authoritative
          // read after all pending writes have finished.
          if (reconcile && get(apiClient$) === createClient) {
            set(confirmedPreferences$, null);
            set(preferenceReadRevision$, (version) => {
              return version + 1;
            });
          }
        }
      }
    });
  },
);
