import { command } from "ccstate";
import { match } from "path-to-regexp";
import { clerk$, clerkUser$, resolveAppAuthUrl } from "../auth.ts";
import { ROUTES } from "../route-paths.ts";
import { detachedNavigateTo$, pathname$, searchParams$ } from "../route.ts";
import { tapError } from "../utils.ts";
import { onboardingStatus$ } from "./onboarding.ts";

const ONBOARDING_GUARDED_PATHS = [
  ROUTES.activityDetail,
  ROUTES.activityInspect,
  ROUTES.agentChat,
  ROUTES.agentDetail,
  ROUTES.agentIdeas,
  ROUTES.agentPermissions,
  ROUTES.agentphoneConnect,
  ROUTES.agents,
  ROUTES.artifacts,
  ROUTES.browser,
  ROUTES.browserAuthorize,
  ROUTES.chat,
  ROUTES.computerUseAuthorize,
  ROUTES.connectors,
  ROUTES.connectorSsh,
  ROUTES.directedAuthorize,
  ROUTES.directedConnect,
  ROUTES.directedReconnect,
  ROUTES.exportData,
  ROUTES.githubConnect,
  ROUTES.home,
  ROUTES.ideas,
  ROUTES.officialWorkflowDetail,
  ROUTES.officialWorkflows,
  ROUTES.prompt,
  ROUTES.redeemCampaign,
  ROUTES.settings,
  ROUTES.settingsFeishu,
  ROUTES.settingsSlack,
  ROUTES.settingsTeams,
  ROUTES.settingsTelegram,
  ROUTES.telegramConnect,
  ROUTES.workflowDetail,
  ROUTES.workflowDetailAutomations,
  ROUTES.workflowDetailInfo,
  ROUTES.workflowDetailInstructions,
  ROUTES.workflows,
  ROUTES.works,
  "/team",
  "/team/:id",
  "/talk/:id",
  "/talk/:id/ideas",
  "/firewall-allow/:id",
  "/activity/:id",
  "/activity/:id/context",
  "/activity/:id/network",
  "/chat/:id",
  "/preferences",
] as const;

const onboardingGuardedPathMatchers = ONBOARDING_GUARDED_PATHS.map((path) => {
  return match(path, { decode: decodeURIComponent });
});

function isOnboardingGuardedPath(pathname: string): boolean {
  return onboardingGuardedPathMatchers.some((matcher) => {
    return matcher(pathname);
  });
}

export const redirectToConfiguredOnboarding$ = command(
  (
    { get, set },
    searchParams: URLSearchParams | undefined,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    set(detachedNavigateTo$, ROUTES.onboarding, {
      searchParams: new URLSearchParams(searchParams ?? get(searchParams$)),
      replace: true,
    });
  },
);

/**
 * Check once during the initial bootstrap whether the current user needs
 * onboarding. This runs concurrently with route setup so page data does not
 * wait for onboarding status.
 *
 * Onboarding is purely admin workspace setup — only an admin whose org has no
 * default agent yet is sent through onboarding. Non-admins never go through it.
 *
 * When the backend cannot resolve the current org (e.g. it was deleted) but the
 * user still belongs to other orgs, redirect to the app's
 * choose-organization page instead of `/onboarding` so they can pick a valid org.
 */
export const bootstrapOnboardingGuard$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (!isOnboardingGuardedPath(get(pathname$))) {
      return;
    }
    const onboardingSearchParams = new URLSearchParams(get(searchParams$));

    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const user = await get(clerkUser$);
    signal.throwIfAborted();
    const session = clerk.session;
    const organization = clerk.organization;
    if (!session || !user || !organization) {
      return;
    }

    const status = await tapError(get(onboardingStatus$));
    signal.throwIfAborted();
    if (
      !status?.needsOnboarding ||
      clerk.session?.id !== session.id ||
      clerk.user?.id !== user.id ||
      clerk.organization?.id !== organization.id ||
      !isOnboardingGuardedPath(get(pathname$))
    ) {
      return;
    }

    if (!status.hasOrg) {
      const memberships = user.organizationMemberships ?? [];
      if (memberships.length > 0) {
        window.location.href = resolveAppAuthUrl(
          "/sign-in/tasks/choose-organization",
        );
        return;
      }
    }

    await set(redirectToConfiguredOnboarding$, onboardingSearchParams, signal);
  },
);
