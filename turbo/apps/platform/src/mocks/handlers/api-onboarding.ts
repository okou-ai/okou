import {
  onboardingCompleteContract,
  onboardingStatusContract,
  type OnboardingStatusResponse,
} from "@okouai/api-contracts/contracts/onboarding";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@okouai/core/brand-presentation";
import { mockApi } from "../msw-contract.ts";

const DEFAULT_ONBOARDING_STATUS: OnboardingStatusResponse = {
  needsOnboarding: false,
  onboardingComplete: true,
  isAdmin: true,
  hasOrg: true,
  hasDefaultAgent: true,
  defaultAgentId: "c0000000-0000-4000-a000-000000000001",
  defaultAgentMetadata: { displayName: DEFAULT_AGENT_DISPLAY_NAME },
};

let mockOnboardingStatus: OnboardingStatusResponse = {
  ...DEFAULT_ONBOARDING_STATUS,
};

export function setMockOnboardingStatus(
  status: Partial<OnboardingStatusResponse>,
): void {
  mockOnboardingStatus = { ...mockOnboardingStatus, ...status };
}

export function resetMockOnboardingStatus(): void {
  mockOnboardingStatus = { ...DEFAULT_ONBOARDING_STATUS };
}

export const apiOnboardingHandlers = [
  // GET /api/onboarding/status
  mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
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
