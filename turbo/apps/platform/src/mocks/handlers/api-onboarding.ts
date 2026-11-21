import {
  onboardingCompleteContract,
  onboardingDraftContract,
  memberOnboardingContract,
  type MemberOnboardingStatus,
} from "@okouai/api-contracts/contracts/onboarding";
import { mockApi } from "../msw-contract.ts";

const DEFAULT_ONBOARDING_STATUS: MemberOnboardingStatus = {
  needsOnboarding: false,
  onboardingComplete: true,
  isAdmin: true,
  hasOrg: true,
};

let mockOnboardingStatus: MemberOnboardingStatus = {
  ...DEFAULT_ONBOARDING_STATUS,
};

export function setMockOnboardingStatus(
  status: Partial<MemberOnboardingStatus>,
): void {
  mockOnboardingStatus = { ...mockOnboardingStatus, ...status };
}

export function resetMockOnboardingStatus(): void {
  mockOnboardingStatus = { ...DEFAULT_ONBOARDING_STATUS };
}

export const apiOnboardingHandlers = [
  // Suites without a server draft exercise the browser draft flow.
  mockApi(onboardingDraftContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        message: "Onboarding draft is unavailable",
        code: "NOT_FOUND",
      },
    });
  }),
  // GET /api/onboarding/member-status
  mockApi(memberOnboardingContract.getStatus, ({ respond }) => {
    return respond(200, mockOnboardingStatus);
  }),

  // POST /api/onboarding/complete
  // An admin completes the organization's onboarding; a member completes only
  // their own, which leaves the organization's `onboardingComplete` as it was.
  mockApi(onboardingCompleteContract.complete, ({ respond }) => {
    mockOnboardingStatus = {
      ...mockOnboardingStatus,
      needsOnboarding: false,
      onboardingComplete:
        mockOnboardingStatus.isAdmin || mockOnboardingStatus.onboardingComplete,
    };
    return respond(200, {
      onboardingComplete: true,
      needsOnboarding: false,
    });
  }),
];
