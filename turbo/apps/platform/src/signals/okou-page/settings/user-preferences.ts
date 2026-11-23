import { command, computed, state } from "ccstate";
import { DEFAULT_USER_TIMEZONE, isValidTimeZone } from "@okouai/core/timezone";
import { userPreferencesContract } from "@okouai/api-contracts/client/user-preferences";
import type {
  InitializedUserPreferencesResponse,
  UpdateUserPreferencesRequest,
  UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import { authenticatedSessionKey$ } from "../../auth.ts";
import { resolveInitialLocaleFallbackFromBrowser } from "../../../i18n/locale-fallback.ts";
import { isSupportedLocale } from "../../../i18n/resources.ts";
import { accept } from "../../../lib/accept.ts";

interface ConfirmedPreferences {
  readonly client: ApiClientFactory;
  readonly owner: string | null;
  readonly fields: Partial<InitializedUserPreferencesResponse>;
}

interface PendingPreferenceSaves {
  readonly client: ApiClientFactory;
  readonly owner: string | null;
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
    const owner = get(authenticatedSessionKey$);
    const createClient = get(apiClient$);
    const checkOwner = () => {
      if (
        get(apiClient$) !== createClient ||
        get(authenticatedSessionKey$) !== owner
      ) {
        throw new DOMException("Preference owner changed", "AbortError");
      }
    };
    const client = createClient(userPreferencesContract, {
      getTokenGuard: () => {
        return checkOwner;
      },
    });
    const result = await accept(client.get(), [200, 409]);
    checkOwner();
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
    checkOwner();
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
  const owner = get(authenticatedSessionKey$);
  const confirmed = get(confirmedPreferences$);
  const initial = await get(initialUserPreferences$);
  return confirmed?.client === client && confirmed.owner === owner
    ? { ...initial, ...confirmed.fields }
    : initial;
});

function confirmedFields(
  update: UpdateUserPreferencesRequest,
  result: UserPreferencesResponse,
): Partial<InitializedUserPreferencesResponse> {
  const timezone = update.timezone === undefined ? undefined : result.timezone;
  const locale = update.locale === undefined ? undefined : result.locale;
  if (
    timezone === null ||
    locale === null ||
    (update.presentationFormat !== undefined &&
      result.presentationFormat !== update.presentationFormat)
  ) {
    throw new Error("Preference write response omitted a written value");
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
    const owner = get(authenticatedSessionKey$);
    const checkOwner = () => {
      if (
        get(apiClient$) !== createClient ||
        get(authenticatedSessionKey$) !== owner
      ) {
        throw new DOMException("Preference owner changed", "AbortError");
      }
    };
    const client = createClient(userPreferencesContract, {
      getTokenGuard: () => {
        return checkOwner;
      },
    });
    const fields = Object.entries(update).flatMap(([key, value]) => {
      return value === undefined ? [] : [key];
    });
    const write = new Set(fields);
    const pending = get(pendingPreferenceSaves$);
    const scoped =
      pending?.client === createClient && pending.owner === owner
        ? pending
        : null;
    const writes = scoped?.writes ?? [];
    set(pendingPreferenceSaves$, {
      client: createClient,
      owner,
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
      checkOwner();
      const previous = get(confirmedPreferences$);
      set(confirmedPreferences$, {
        client: createClient,
        owner,
        fields: {
          ...(previous?.client === createClient && previous.owner === owner
            ? previous.fields
            : {}),
          ...confirmedFields(update, saved.body),
        },
      });
    })();
    await save.finally(() => {
      const current = get(pendingPreferenceSaves$);
      if (current?.client === createClient && current.owner === owner) {
        const remaining = current.writes.filter((entry) => {
          return entry !== write;
        });
        if (remaining.length > 0) {
          set(pendingPreferenceSaves$, { ...current, writes: remaining });
        } else {
          set(pendingPreferenceSaves$, null);
          // Competing writes to one field may finish in a different order than
          // they commit. Reconcile once, after the last response.
          if (
            current.reconcile &&
            get(apiClient$) === createClient &&
            get(authenticatedSessionKey$) === owner
          ) {
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
