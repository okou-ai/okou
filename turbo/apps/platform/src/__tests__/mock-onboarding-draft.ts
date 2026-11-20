import { onboardingDraftContract } from "@okouai/api-contracts/contracts/onboarding";
import type { OnboardingDraftPayload } from "@okouai/api-contracts/validators/onboarding";
import type { TestContext } from "../signals/__tests__/test-helpers.ts";

/** A single member's draft survives the replacement of their browser app. */
export function mockOnboardingDraft(context: TestContext) {
  let draft: (OnboardingDraftPayload & { revision: string }) | null = null;
  context.mocks.api(onboardingDraftContract.get, ({ respond }) => {
    return respond(200, { draft });
  });
  context.mocks.api(onboardingDraftContract.save, ({ body, respond }) => {
    const revision = crypto.randomUUID();
    draft = { ...body, revision };
    return respond(200, { revision });
  });
  return () => {
    return draft;
  };
}
