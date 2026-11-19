import { command } from "ccstate";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/client/morning-brief-preference";
import { MORNING_BRIEF_PREFERENCES_FOCUS } from "@okouai/api-contracts/validators/morning-brief-preference";
import type {
  MorningBriefPreferenceErrorCode,
  MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";

import { accept } from "../../../lib/accept.ts";
import { searchParams$ } from "../../route.ts";
import { onRef } from "../../utils.ts";
import { createProactivePreference } from "./proactive-preference-resource.ts";
import { userPreferences$ } from "./user-preferences.ts";

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

export const {
  preference$: morningBriefPreference$,
  update$: updateMorningBriefPreference$,
} = createProactivePreference(
  // Initialization and time zone saves can recover the existing installation.
  userPreferences$,
  async (client) => {
    return preferenceState(
      await accept(client(morningBriefPreferenceContract).get(), [200, 409]),
    );
  },
  async (client, enabled, signal) => {
    const result = await accept(
      client(morningBriefPreferenceContract).update({
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200, 400, 409],
    );
    return { saved: result.status === 200, value: preferenceState(result) };
  },
);

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
