import { onboardingDraftContract } from "@okouai/api-contracts/client/onboarding";
import {
  onboardingDraftPayloadSchema,
  type OnboardingDraftPayload,
} from "@okouai/api-contracts/validators/onboarding";
import { command, state } from "ccstate";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";
import { throttleCommand } from "../utils.ts";

interface DraftOwner {
  readonly orgId: string;
  readonly userId: string;
}

export const loadServerOnboardingDraft$ = command(
  async ({ get }, owner: DraftOwner, signal: AbortSignal) => {
    const sessionKey = get(authenticatedSessionKey$);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const guard = () => {
      if (
        !sessionKey ||
        sessionKey !== get(authenticatedSessionKey$) ||
        clerk.organization?.id !== owner.orgId ||
        clerk.user?.id !== owner.userId
      ) {
        throw new DOMException("Onboarding draft owner changed", "AbortError");
      }
    };
    const client = get(apiClient$)(onboardingDraftContract, {
      getTokenGuard: () => {
        guard();
        return guard;
      },
    });
    // The API answers 404 when this member no longer needs onboarding.
    const response = await accept(
      client.get({ fetchOptions: { signal } }),
      [200, 404],
      signal,
    );
    signal.throwIfAborted();
    guard();
    return response.status === 200
      ? { client, snapshot: response.body.draft, guard }
      : null;
  },
);

type ServerOnboardingDraft = NonNullable<
  Awaited<ReturnType<typeof loadServerOnboardingDraft$.write>>
>;

export function createServerOnboardingDraftSync(
  { client, snapshot, guard }: ServerOnboardingDraft,
  ownerSignal: AbortSignal,
) {
  const revision$ = state(snapshot?.revision ?? null);
  const savedPayload$ = state(snapshot ? serializedPayload(snapshot) : null);
  const stopped$ = state(false);

  const write$ = command(
    async (
      { get, set },
      payload: OnboardingDraftPayload,
      signal: AbortSignal,
    ) => {
      if (get(stopped$)) {
        return;
      }
      const serialized = serializedPayload(payload);
      if (serialized === get(savedPayload$)) {
        return;
      }
      const result = await accept(
        client.save({
          body: { ...payload, revision: get(revision$) },
          fetchOptions: { signal },
        }),
        [200, 404, 409],
        signal,
      );
      signal.throwIfAborted();
      guard();
      if (result.status !== 200) {
        // Stop this client after a completed flow or a competing editor. A
        // reload restores the saved revision instead of overwriting it.
        set(stopped$, true);
        if (result.status === 409) {
          await accept(Promise.resolve(result), [200], signal);
        }
        return;
      }
      set(revision$, result.body.revision);
      set(savedPayload$, serialized);
    },
  );

  const throttledWrite$ = throttleCommand(write$, 300);
  return command(({ set }, payload: OnboardingDraftPayload) => {
    return set(throttledWrite$, payload, ownerSignal);
  });
}

function serializedPayload(payload: OnboardingDraftPayload): string {
  // Read from JSONB can change property order. Compare canonical schema order.
  return JSON.stringify({
    answers: onboardingDraftPayloadSchema.shape.answers.parse(payload.answers),
    step: payload.step,
  });
}
