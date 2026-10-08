import { command, computed, state } from "ccstate";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import {
  type UserPreferenceChangedPayload,
  userPreferenceChangedPayloadSchema,
} from "@okouai/api-contracts/contracts/realtime";
import {
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
  userModelPreferenceContract,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";

const internalReloadUserModelPreference$ = state(0);

export const userModelPreference$ = computed(async (get) => {
  get(internalReloadUserModelPreference$);
  const createClient = get(apiClient$);
  const client = createClient(userModelPreferenceContract, {
    apiBase: "api",
  });
  const result = await accept(client.get(), [200]);
  return result.body;
});

/**
 * The image model built-in image generation uses for this member: their
 * Settings choice, else the catalog default. Runs resolve the same two layers.
 */
export const effectiveImageModel$ = computed(
  async (get): Promise<ImageModel> => {
    const preference = await get(userModelPreference$);
    return preference.selectedImageModel ?? DEFAULT_IMAGE_MODEL;
  },
);

export const reloadUserModelPreference$ = command(({ set }) => {
  set(internalReloadUserModelPreference$, (value) => {
    return value + 1;
  });
});

export const updateUserModelPreference$ = command(
  async (
    { get },
    update: UpdateUserModelPreferenceRequest,
    signal: AbortSignal,
  ): Promise<UserModelPreferenceResponse> => {
    const createClient = get(apiClient$);
    const client = createClient(userModelPreferenceContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.update({
        body: update,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    // Cross-device/default-model writes are reflected via the
    // `userPreferenceChanged` realtime topic; do not reload the local cache
    // here (the initiating session receives the push like any other).
    return result.body;
  },
);

function payloadRequestsKindsReloadFor(
  payload: unknown,
  kinds: UserPreferenceChangedPayload["kinds"],
): boolean {
  const parsed = userPreferenceChangedPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return false;
  }
  return parsed.data.kinds.some((kind) => {
    return kinds.includes(kind);
  });
}

const handleUserPreferenceChanged$ = command(
  ({ set }, payload: unknown): boolean => {
    if (
      payloadRequestsKindsReloadFor(payload, [
        "defaultModel",
        "defaultImageModel",
      ])
    ) {
      set(reloadUserModelPreference$);
    }
    return false;
  },
);

export const setupUserPreferenceRealtime$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyPayloadLoop$,
      {
        topic: "userPreferenceChanged",
        loopCommand$: handleUserPreferenceChanged$,
      },
      signal,
    );
  },
);
