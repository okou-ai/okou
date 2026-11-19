import { onboardingDraftContract } from "@okouai/api-contracts/contracts/onboarding";
import { command } from "ccstate";
import { conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  deleteOnboardingDraft$,
  onboardingDraft,
  saveOnboardingDraft$,
} from "../services/onboarding-draft.service";
import { needsOnboarding } from "../services/onboarding.service";

const authOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;
const unavailable = notFound("Onboarding draft is unavailable");
const saveBody$ = bodyResultOf(onboardingDraftContract.save);

const draftAvailable$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const auth = get(organizationAuthContext$);
  const available = await get(needsOnboarding(auth));
  signal.throwIfAborted();
  return available;
});

const getDraft$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(draftAvailable$, signal))) {
    return unavailable;
  }
  const draft = await get(onboardingDraft(get(organizationAuthContext$)));
  signal.throwIfAborted();
  return { status: 200 as const, body: { draft } };
});

const saveDraft$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(draftAvailable$, signal))) {
    return unavailable;
  }
  const body = await get(saveBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  const { revision, ...payload } = body.data;
  const written = await set(
    saveOnboardingDraft$,
    auth,
    payload,
    revision,
    signal,
  );
  if (!written) {
    return conflict(
      "Onboarding draft changed. Reload to resume the saved draft.",
    );
  }
  // Completion can commit while a save was waiting to write. Check in a fresh
  // snapshot so a late first save cannot recreate an already-completed draft.
  if (!(await get(needsOnboarding(auth)))) {
    await set(deleteOnboardingDraft$, auth);
    signal.throwIfAborted();
    return unavailable;
  }
  signal.throwIfAborted();
  return { status: 200 as const, body: written };
});

export const onboardingDraftRoutes: readonly RouteEntry[] = [
  {
    route: onboardingDraftContract.get,
    handler: authRoute(authOptions, getDraft$),
  },
  {
    route: onboardingDraftContract.save,
    handler: authRoute(authOptions, saveDraft$),
  },
];
