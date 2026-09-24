import { command, computed, state } from "ccstate";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import type { VideoModel } from "@okouai/core/video-model-catalog";
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

/**
 * Makes a video model the member default without disturbing the run model.
 *
 * The request must carry the run model, so this reads the stored one back
 * instead of echoing the cached copy: the sibling run-model notice writes
 * through the same resource, and `updateUserModelPreference$` leaves the cache
 * to the `userPreferenceChanged` push rather than refreshing it. Echoing the
 * cache would resend a run model that a moments-old write already replaced.
 */
export const updateDefaultVideoModel$ = command(
  async (
    { get, set },
    videoModel: VideoModel,
    signal: AbortSignal,
  ): Promise<void> => {
    set(reloadUserModelPreference$);
    const preference = await get(userModelPreference$);
    signal.throwIfAborted();
    await set(
      updateUserModelPreference$,
      {
        selectedModel: preference.selectedModel,
        serviceTier: preference.serviceTier,
        selectedVideoModel: videoModel,
      },
      signal,
    );
  },
);

/** Makes an image model the member default without disturbing sibling fields. */
export const updateDefaultImageModel$ = command(
  async (
    { get, set },
    imageModel: ImageModel,
    signal: AbortSignal,
  ): Promise<void> => {
    set(reloadUserModelPreference$);
    const preference = await get(userModelPreference$);
    signal.throwIfAborted();
    await set(
      updateUserModelPreference$,
      {
        selectedModel: preference.selectedModel,
        serviceTier: preference.serviceTier,
        selectedImageModel: imageModel,
      },
      signal,
    );
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
        "defaultVideoModel",
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
