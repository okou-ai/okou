import { command, computed, state } from "ccstate";
import {
  morningBriefPreferenceContract,
  MORNING_BRIEF_PREFERENCES_FOCUS,
  type MorningBriefPreferenceErrorCode,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";

import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { setAblyPayloadLoop$ } from "../../realtime.ts";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { searchParams$ } from "../../route.ts";
import { onRef, settle } from "../../utils.ts";
import { logger } from "../../log.ts";

const L = logger("MorningBrief");

export type MorningBriefPreferenceState =
  | {
      readonly kind: "ready";
      readonly preference: MorningBriefPreferenceResponse;
    }
  | {
      readonly kind: "error";
      readonly code: MorningBriefPreferenceErrorCode;
      readonly message: string;
    };

const morningBriefPreferenceVersion$ = state(0);

function preferenceState(
  result:
    | { readonly status: 200; readonly body: MorningBriefPreferenceResponse }
    | {
        readonly status: 400 | 409;
        readonly body: {
          readonly error: {
            readonly code: MorningBriefPreferenceErrorCode;
            readonly message: string;
          };
        };
      },
): MorningBriefPreferenceState {
  return result.status === 200
    ? { kind: "ready", preference: result.body }
    : {
        kind: "error",
        code: result.body.error.code,
        message: result.body.error.message,
      };
}

export const morningBriefPreference$ = computed(async (get) => {
  get(morningBriefPreferenceVersion$);
  get(searchParams$);
  const client = get(apiClient$)(morningBriefPreferenceContract);
  const result = await accept(client.get(), [200, 409]);
  return preferenceState(result);
});

export const updateMorningBriefPreference$ = command(
  async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
    const client = get(apiClient$)(morningBriefPreferenceContract);
    const result = await accept(
      client.update({
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200, 400, 409],
    );
    signal.throwIfAborted();
    set(morningBriefPreferenceVersion$, (version) => {
      return version + 1;
    });
    return preferenceState(result);
  },
);

export const retryMorningBriefPreference$ = command(({ set }) => {
  set(morningBriefPreferenceVersion$, (version) => {
    return version + 1;
  });
});

export const morningBriefPreferenceCardRef$ = onRef(
  command(({ get }, element: HTMLElement, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (get(searchParams$).get("focus") !== MORNING_BRIEF_PREFERENCES_FOCUS) {
      return;
    }
    element.scrollIntoView({ block: "center" });
    element.focus({ preventScroll: true });
  }),
);

const reloadMorningBriefFromPush$ = command(({ set }) => {
  set(retryMorningBriefPreference$);
  return false;
});
/** Optional enrollment failures stay isolated from application and connector lifecycles. */
export const initializeMorningBriefEnrollment$ = command(
  async (
    { get, set },
    body: { readonly timezone?: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(apiClient$)(userPreferencesContract);
    const result = await settle(
      accept(client.initialize({ body, fetchOptions: { signal } }), [200]),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      L.warn(
        "Morning Brief initialization failed; a later visit or connector change can retry",
        result.error,
      );
    }
    set(retryMorningBriefPreference$);
  },
);

const retryMorningBriefAfterConnectorChange$ = command(
  async ({ set }, _payload: unknown, signal: AbortSignal) => {
    await set(initializeMorningBriefEnrollment$, {}, signal);
    signal.throwIfAborted();
    return false;
  },
);
export const setupMorningBriefRealtime$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await Promise.all([
      set(
        setAblyPayloadLoop$,
        {
          scope: "credential",
          topic: "morningBriefChanged",
          loopCommand$: reloadMorningBriefFromPush$,
          initializeCommand$: reloadMorningBriefFromPush$,
        },
        signal,
      ),
      set(
        setAblyPayloadLoop$,
        {
          topic: "connector:changed",
          loopCommand$: retryMorningBriefAfterConnectorChange$,
        },
        signal,
      ),
      set(
        setAblyPayloadLoop$,
        {
          topic: "slack:changed",
          loopCommand$: retryMorningBriefAfterConnectorChange$,
        },
        signal,
      ),
    ]);
  },
);
