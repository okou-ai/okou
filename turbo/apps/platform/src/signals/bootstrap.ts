import { command, type Command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isDesktopAuthFlow } from "../lib/desktop-auth-flow.ts";
import { setupDesktopAuthPage } from "./desktop-auth/desktop-auth.ts";
import {
  clerk$,
  setupClerk$,
  setupClerkUser$,
  watchOrgSwitch$,
} from "./auth.ts";
import {
  runAuthenticatedRealtime$,
  setupAuthenticatedBootstrapData$,
} from "./authenticated-daemons.ts";
import { initTheme$, syncColorThemePreference$ } from "./theme.ts";
import { initializeAppVersion$ } from "./app-version.ts";
import { initLocale$, syncLocalePreference$ } from "./locale.ts";
import { setRootSignal$ } from "./root-signal.ts";
import { setApiClientRuntime$ } from "./api-client-runtime.ts";
import { readClerkToken } from "./clerk-token.ts";
import { setupSharedDatabaseBridge$ } from "./shared-database-browser.ts";
import { listenSharedWorkerFailure$ } from "./shared-worker-failure.ts";
import { resolveApiBaseForTarget, resolveOAuthApiBase } from "./api-base.ts";
import { getCapturedPreviewBypassForTarget } from "../lib/preview-bypass-cookie.ts";
import {
  initRoutes$,
  detachedNavigateTo$,
  setupPageWrapper,
  setupAuthPageWrapper,
  pathParams$,
  pathname$,
  type RouterPathParams,
} from "./route.ts";
import { registerServiceWorker$ } from "../lib/push-notifications.ts";
import { onDomEventFn } from "./utils.ts";
import "./pwa-install.ts";
import { ROUTES, type RoutePath } from "./route-paths.ts";

import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { setupSlackConnectPage$ } from "./okou-page/slack-connect-page.ts";
import { setupAgentPhoneConnectPage$ } from "./okou-page/agentphone-connect-page.ts";
import { setupGithubConnectPage$ } from "./okou-page/github-connect-page.ts";
import { setupTeamsConnectPage$ } from "./okou-page/teams-connect-page.ts";
import { setupTelegramConnectPage$ } from "./okou-page/telegram-connect-page.ts";
import { setupTelegramSettingsPage$ } from "./okou-page/telegram-settings-page.ts";
import { setupSshConnectorPage$ } from "./okou-page/ssh-connector-page.ts";
import { setupFeishuSettingsPage$ } from "./okou-page/feishu-settings-page.ts";
import { setupFeishuOAuthCallbackPage$ } from "./okou-page/feishu-oauth-callback-page.ts";
import { setupActivityDetailPage$ } from "./activity-page/activity-detail-page-setup.ts";
import { setupActivityInspectPage$ } from "./activity-page/activity-inspect-page-setup.ts";
import { setupAgentsPage$ } from "./agents-page/agents-page-setup.ts";
import { setupAgentDetailPage$ } from "./agents-page/agent-detail-page-setup.ts";
import { setupArtifactsPage$ } from "./artifacts-page/artifacts-page-setup.ts";
import { setupWorkflowsPage$ } from "./workflows-page/workflows-page-setup.ts";
import { setupWorkflowDetailPage$ } from "./workflows-page/workflow-detail-page-setup.ts";
import { setupOfficialWorkflowsPage$ } from "./workflows-page/official-workflows-page-setup.ts";
import { setupWorksPage$ } from "./works-page/works-page-setup.ts";
import { setupAgentChatPage$ } from "./okou-page/agent-chat-page-setup.ts";
import { setupHomePage$ } from "./okou-page/home-page-setup.ts";
import { setupChatPage$ } from "./chat-page/chat-page-setup.ts";
import { setupPromptPage$ } from "./prompt-page/prompt-page-setup.ts";
import {
  setupOnboardingImageRunPage$,
  setupOnboardingImageTemplatePage$,
  setupOnboardingMakePage$,
  setupOnboardingPresentationRunPage$,
  setupOnboardingPresentationTemplatePage$,
  setupOnboardingVideoRunPage$,
  setupOnboardingVideoTemplatePage$,
  setupOnboardingWorkflowPickerPage$,
  setupOnboardingWorkflowRunPage$,
} from "./onboarding/onboarding-page-setup.ts";
import { setupIdeationPage$ } from "./okou-page/ideation-page-setup.ts";
import { setupConnectorsPage$ } from "./connectors-page/connectors-page-setup.ts";
import { setupComputerUseAuthorizationPage$ } from "./computer-use-authorization/computer-use-authorization-page-setup.ts";
import { setupBrowserAuthorizationPage$ } from "./browser-authorization/browser-authorization-page-setup.ts";
import { setupBrowserSessionPage$ } from "./browser-session/browser-session-page-setup.ts";
import { setupDirectedConnectPage$ } from "./connectors-page/directed-connect-page-setup.ts";
import { setupDirectedAuthorizePage$ } from "./connectors-page/directed-authorize-page-setup.ts";
import { setupConnectorRedirectingPage$ } from "./connectors-page/connector-redirecting-page-setup.ts";
import { setupConnectorCallbackPage$ } from "./connectors-page/connector-callback-page-setup.ts";
import { setupBankingConnectReturnPage$ } from "./banking-connect-return-page-setup.ts";
import { setupEmailUnsubscribePage$ } from "./email-unsubscribe/email-unsubscribe-page-setup.ts";
import { setupSignInTokenPage$ } from "./sign-in-token-setup.ts";
import {
  setupSignInV1Page$,
  setupSignUpV1Page$,
} from "./auth-v1-page-setup.ts";
import { setupPermissionAllowPage$ } from "./permission-allow/permission-allow-page-setup.ts";
import { setupLabPage$ } from "./lab-page/lab-page-setup.ts";
import { setupExportPage$ } from "./export-page/export-page-setup.ts";
import { initSlackOrg$ as handleSlackRedirect$ } from "./okou-page/slack.ts";
import { setupSkeletonPage$, setupErrorPage$ } from "./skeleton-page-setup.ts";
import { hideAppSkeleton$, initBootstrapSkeleton$ } from "./app-skeleton.ts";
import { setupRedeemCampaignPage$ } from "./redeem-campaign/redeem-campaign-page-setup.ts";
import { updatePage$ } from "./react-router.ts";
import { setupLegacySettingsRedirect$ } from "./okou-page/settings/legacy-settings-redirect.ts";
import { NotFoundPage } from "../views/not-found-page.tsx";
import { setupSharedArtifact$ } from "./shared-artifact.ts";
import { setupSharedThreadPage$ } from "./shared-thread-page/shared-thread-page-setup.ts";

import { setupGlobalKeyboardShortcuts$ } from "./okou-page/nav.ts";
import { bootstrapOnboardingGuard$ } from "./okou-page/onboard-guard.ts";
import {
  featureSwitch$,
  reloadFeatureSwitch$,
} from "./external/feature-switch.ts";
import {
  setupConnectionDiagnostics$,
  writeConnectionDiagnostic$,
} from "./connection-diagnostics.ts";
import { checkUnifiedSettingsParam$ } from "./okou-page/settings/settings-dialog.ts";
import { captureInvitationRedirect$ } from "./invitation-redirect.ts";
import {
  initBootstrapPhaseTiming$,
  markBootstrapLocaleInitCompleted$,
  markBootstrapLocaleInitStarted$,
} from "../lib/posthog.ts";

const setupNotFoundPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(NotFoundPage));
  await set(hideAppSkeleton$, signal);
});

/**
 * Create a redirect setup command for static routes (no params to forward).
 */
function redirectTo(target: RoutePath) {
  return command(({ set }) => {
    set(detachedNavigateTo$, target, { replace: true });
  });
}

/**
 * Create a redirect setup command for parameterized routes.
 * Reads the `id` param from the source URL and maps it to `targetParam` on the target route.
 */
function redirectWithId(target: RoutePath, targetParam: string) {
  return command(({ get, set }) => {
    const params = get(pathParams$) ?? {};
    set(detachedNavigateTo$, target, {
      pathParams: { [targetParam]: String(params.id) } as RouterPathParams,
      replace: true,
    });
  });
}

function setupSettingsParamAfterStableRoute(
  setupPage: Command<Promise<void> | void, [AbortSignal]>,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const initialPathname = get(pathname$);
    await set(setupPage, signal);
    signal.throwIfAborted();
    if (get(pathname$) !== initialPathname) {
      return;
    }
    await set(checkUnifiedSettingsParam$, signal);
  });
}

function setupAuthSidebarPageWrapper(
  setupPage: Command<Promise<void> | void, [AbortSignal]>,
) {
  return setupAuthPageWrapper(setupSettingsParamAfterStableRoute(setupPage));
}

const ROUTE_CONFIG = [
  {
    path: ROUTES.desktopAuthStart,
    setup: setupPageWrapper(setupDesktopAuthPage("start")),
    analytics: false,
  },
  {
    path: ROUTES.desktopAuthCallback,
    setup: setupPageWrapper(setupDesktopAuthPage("callback")),
    analytics: false,
  },
  {
    path: ROUTES.desktopAuthConsume,
    setup: setupPageWrapper(setupDesktopAuthPage("consume")),
    analytics: false,
  },
  {
    path: ROUTES.desktopAuthToken,
    setup: setupPageWrapper(setupDesktopAuthPage("token")),
    analytics: false,
  },
  {
    path: ROUTES.desktopAuthSelectOrg,
    setup: setupPageWrapper(setupDesktopAuthPage("select-org")),
    analytics: false,
  },

  {
    path: ROUTES.sharedArtifact,
    setup: setupPageWrapper(setupSharedArtifact$),
    analytics: false,
  },
  {
    // Retained share links have no TTL; #32492 owns their compatibility drain.
    path: ROUTES.legacySharedArtifact,
    setup: setupPageWrapper(setupSharedArtifact$),
    analytics: false,
  },
  {
    path: ROUTES.sharedThread,
    setup: setupSharedThreadPage$,
    analytics: false,
  },
  {
    path: ROUTES.signIn,
    setup: setupPageWrapper(setupSignInV1Page$),
  },
  {
    path: ROUTES.signInCatchAll,
    setup: setupPageWrapper(setupSignInV1Page$),
  },
  {
    path: ROUTES.signUp,
    setup: setupPageWrapper(setupSignUpV1Page$),
  },
  {
    path: ROUTES.signUpCatchAll,
    setup: setupPageWrapper(setupSignUpV1Page$),
  },

  // --- New routes ---
  {
    path: ROUTES.chat,
    setup: setupAuthSidebarPageWrapper(setupChatPage$),
  },
  {
    path: ROUTES.browser,
    setup: setupAuthPageWrapper(setupBrowserSessionPage$),
  },
  {
    path: ROUTES.prompt,
    setup: setupAuthPageWrapper(setupPromptPage$),
  },
  {
    path: ROUTES.ideas,
    setup: setupAuthSidebarPageWrapper(setupIdeationPage$),
  },
  {
    path: ROUTES.computerUseAuthorize,
    setup: setupAuthPageWrapper(setupComputerUseAuthorizationPage$),
  },
  {
    path: ROUTES.browserAuthorize,
    setup: setupAuthPageWrapper(setupBrowserAuthorizationPage$),
  },
  {
    path: ROUTES.bankingConnectReturnResult,
    setup: setupBankingConnectReturnPage$,
  },
  {
    path: ROUTES.bankingConnectReturn,
    setup: setupBankingConnectReturnPage$,
  },
  {
    path: ROUTES.connectorCallbackResult,
    setup: setupConnectorCallbackPage$,
  },
  {
    path: ROUTES.feishuOAuthCallback,
    setup: setupFeishuOAuthCallbackPage$,
  },
  {
    path: ROUTES.connectorCallback,
    setup: setupConnectorCallbackPage$,
  },
  {
    path: ROUTES.connectorRedirecting,
    setup: setupConnectorRedirectingPage$,
  },
  {
    path: ROUTES.emailUnsubscribe,
    setup: setupEmailUnsubscribePage$,
  },
  {
    path: ROUTES.directedAuthorize,
    setup: setupAuthPageWrapper(setupDirectedAuthorizePage$),
  },
  {
    path: ROUTES.directedReconnect,
    setup: setupAuthPageWrapper(setupDirectedConnectPage$),
  },
  {
    path: ROUTES.directedConnect,
    setup: setupAuthPageWrapper(setupDirectedConnectPage$),
  },
  {
    path: ROUTES.connectors,
    setup: setupAuthSidebarPageWrapper(setupConnectorsPage$),
  },
  {
    path: ROUTES.connectorSsh,
    setup: setupAuthSidebarPageWrapper(setupSshConnectorPage$),
  },
  {
    path: ROUTES.agentIdeas,
    setup: setupAuthSidebarPageWrapper(setupIdeationPage$),
  },
  {
    path: ROUTES.agentChat,
    setup: setupAuthPageWrapper(setupAgentChatPage$),
  },
  {
    path: ROUTES.agentPermissions,
    setup: setupAuthPageWrapper(setupPermissionAllowPage$),
  },
  {
    path: ROUTES.officialWorkflowDetail,
    setup: setupAuthSidebarPageWrapper(setupOfficialWorkflowsPage$),
  },
  {
    path: ROUTES.officialWorkflows,
    setup: setupAuthSidebarPageWrapper(setupOfficialWorkflowsPage$),
  },
  {
    path: ROUTES.workflowDetail,
    setup: setupAuthSidebarPageWrapper(setupWorkflowDetailPage$),
  },
  {
    path: ROUTES.workflowDetailAutomations,
    setup: setupAuthSidebarPageWrapper(setupWorkflowDetailPage$),
  },
  {
    path: ROUTES.workflowDetailInstructions,
    setup: setupAuthSidebarPageWrapper(setupWorkflowDetailPage$),
  },
  {
    path: ROUTES.workflowDetailInfo,
    setup: setupAuthSidebarPageWrapper(setupWorkflowDetailPage$),
  },
  {
    path: ROUTES.workflows,
    setup: setupAuthSidebarPageWrapper(setupWorkflowsPage$),
  },
  {
    path: ROUTES.agentDetail,
    setup: setupAuthSidebarPageWrapper(setupAgentDetailPage$),
  },
  {
    path: ROUTES.agents,
    setup: setupAuthSidebarPageWrapper(setupAgentsPage$),
  },
  {
    path: ROUTES.artifacts,
    setup: setupAuthSidebarPageWrapper(setupArtifactsPage$),
  },
  {
    path: ROUTES.settingsSlack,
    setup: setupAuthSidebarPageWrapper(setupSlackConnectPage$),
  },
  {
    path: ROUTES.settingsTeams,
    setup: setupAuthSidebarPageWrapper(setupTeamsConnectPage$),
  },
  {
    path: ROUTES.settingsFeishu,
    setup: setupAuthSidebarPageWrapper(setupFeishuSettingsPage$),
  },
  {
    path: ROUTES.settingsTelegram,
    setup: setupAuthSidebarPageWrapper(setupTelegramSettingsPage$),
  },
  {
    path: ROUTES.githubConnect,
    setup: setupAuthPageWrapper(setupGithubConnectPage$),
  },
  {
    path: ROUTES.telegramConnect,
    setup: setupAuthPageWrapper(setupTelegramConnectPage$),
  },
  {
    path: ROUTES.agentphoneConnect,
    setup: setupAuthPageWrapper(setupAgentPhoneConnectPage$),
  },
  {
    path: ROUTES.activityInspect,
    setup: setupAuthSidebarPageWrapper(setupActivityInspectPage$),
  },
  {
    path: ROUTES.activityDetail,
    setup: setupAuthSidebarPageWrapper(setupActivityDetailPage$),
  },
  {
    path: ROUTES.works,
    setup: setupAuthSidebarPageWrapper(setupWorksPage$),
  },
  {
    path: ROUTES.settings,
    setup: setupAuthPageWrapper(setupLegacySettingsRedirect$),
  },
  {
    path: ROUTES.lab,
    setup: setupAuthSidebarPageWrapper(setupLabPage$),
  },
  {
    path: ROUTES.exportData,
    setup: setupAuthPageWrapper(setupExportPage$),
  },
  {
    path: ROUTES.onboarding,
    setup: setupAuthPageWrapper(setupOnboardingMakePage$),
  },
  {
    path: ROUTES.onboardingWorkflowPicker,
    setup: setupAuthPageWrapper(setupOnboardingWorkflowPickerPage$),
  },
  {
    path: ROUTES.onboardingWorkflowRun,
    setup: setupAuthPageWrapper(setupOnboardingWorkflowRunPage$),
  },
  {
    path: ROUTES.onboardingPresentationTemplate,
    setup: setupAuthPageWrapper(setupOnboardingPresentationTemplatePage$),
  },
  {
    path: ROUTES.onboardingPresentationRun,
    setup: setupAuthPageWrapper(setupOnboardingPresentationRunPage$),
  },
  {
    path: ROUTES.onboardingImageTemplate,
    setup: setupAuthPageWrapper(setupOnboardingImageTemplatePage$),
  },
  {
    path: ROUTES.onboardingImageRun,
    setup: setupAuthPageWrapper(setupOnboardingImageRunPage$),
  },
  {
    path: ROUTES.onboardingVideoTemplate,
    setup: setupAuthPageWrapper(setupOnboardingVideoTemplatePage$),
  },
  {
    path: ROUTES.onboardingVideoRun,
    setup: setupAuthPageWrapper(setupOnboardingVideoRunPage$),
  },
  {
    path: ROUTES.signInToken,
    setup: setupSignInTokenPage$,
  },
  {
    path: ROUTES.redeemCampaign,
    setup: setupAuthPageWrapper(setupRedeemCampaignPage$),
  },
  {
    path: ROUTES.skeleton,
    setup: setupSkeletonPage$,
  },
  {
    path: ROUTES.error,
    setup: setupErrorPage$,
  },
  {
    path: ROUTES.home,
    setup: setupAuthPageWrapper(
      setupSettingsParamAfterStableRoute(setupHomePage$),
    ),
  },

  // --- Redirect routes (backward compatibility) ---
  { path: "/team", setup: redirectTo(ROUTES.agents) },
  { path: "/team/:id", setup: redirectWithId(ROUTES.agentDetail, "agentId") },
  { path: "/talk/:id", setup: redirectWithId(ROUTES.agentChat, "agentId") },
  {
    path: "/talk/:id/ideas",
    setup: redirectWithId(ROUTES.agentIdeas, "agentId"),
  },
  {
    path: "/firewall-allow/:id",
    setup: redirectWithId(ROUTES.agentPermissions, "agentId"),
  },
  {
    path: "/activity/:id",
    setup: redirectWithId(ROUTES.activityDetail, "activityRunId"),
  },
  {
    path: "/activity/:id/context",
    setup: redirectWithId(ROUTES.activityDetail, "activityRunId"),
  },
  {
    path: "/activity/:id/network",
    setup: redirectWithId(ROUTES.activityDetail, "activityRunId"),
  },
  { path: "/chat/:id", setup: redirectWithId(ROUTES.chat, "threadId") },
  {
    path: "/preferences",
    setup: setupAuthPageWrapper(setupLegacySettingsRedirect$),
  },

  {
    // Catch-all: keep unknown paths in place and show the not-found surface.
    path: "{/*path}",
    setup: setupNotFoundPage$,
  },
] as const;

const setupRoutes$ = command(async ({ set }, signal: AbortSignal) => {
  await set(initRoutes$, ROUTE_CONFIG, signal);
});

const setupFeatureSwitches$ = command(async ({ set }, signal: AbortSignal) => {
  await set(reloadFeatureSwitch$, signal);
  await set(syncLocalePreference$, signal);
  await set(syncColorThemePreference$, signal);
});

function notificationChatThreadId(data: unknown): string | null {
  if (
    typeof data !== "object" ||
    data === null ||
    !("type" in data) ||
    data.type !== "NOTIFICATION_CLICK" ||
    !("url" in data) ||
    typeof data.url !== "string" ||
    !URL.canParse(data.url, window.location.origin)
  ) {
    return null;
  }

  const url = new URL(data.url, window.location.origin);
  if (url.origin !== window.location.origin) {
    return null;
  }

  return /^\/chats\/([^/]+)$/u.exec(url.pathname)?.[1] ?? null;
}

const setupNotificationListener$ = command(({ set }, signal: AbortSignal) => {
  navigator.serviceWorker?.addEventListener(
    "message",
    onDomEventFn((event: MessageEvent<unknown>): void => {
      const threadId = notificationChatThreadId(event.data);
      if (threadId) {
        set(detachedNavigateTo$, ROUTES.chat, {
          pathParams: { threadId },
        });
      }
    }),
    {
      signal,
    },
  );
});

const completeBootstrap$ = command(
  async ({ set }, render: () => void, signal: AbortSignal): Promise<void> => {
    await set(initLocale$, signal);
    signal.throwIfAborted();
    set(markBootstrapLocaleInitCompleted$);
    set(initTheme$, signal);

    render();

    // These public protocol pages also run before an embedded Clerk session exists.
    // Hosted Clerk task continuations retain the same ownership via redirect_url.
    if (isDesktopAuthFlow()) {
      await Promise.all([
        set(setupClerk$, signal),
        set(watchOrgSwitch$, signal),
        set(setupRoutes$, signal),
      ]);
      signal.throwIfAborted();
      return;
    }

    set(handleSlackRedirect$);

    await Promise.all([
      set(setupAuthenticatedBootstrapData$, signal),
      set(setupRoutes$, signal),
      set(bootstrapOnboardingGuard$, signal),
      set(setupGlobalMethod$, signal),
      set(registerServiceWorker$, signal),
      set(setupNotificationListener$, signal),

      set(setupGlobalKeyboardShortcuts$, signal),
      set(watchOrgSwitch$, signal),
      set(setupFeatureSwitches$, signal),
    ]);

    signal.throwIfAborted();
  },
);

interface BootstrapRuntime {
  readonly authenticatedRealtimeDaemon: Promise<void>;
  readonly clerkIdentityDaemon: Promise<void>;
  readonly ready: Promise<void>;
  readonly sharedDatabaseDaemon: Promise<void>;
}

export const bootstrap$ = command(
  (
    { get, set },
    appVersion: string,
    render: () => void,
    signal: AbortSignal,
  ): BootstrapRuntime => {
    set(initializeAppVersion$, appVersion);
    set(initBootstrapPhaseTiming$);
    set(captureInvitationRedirect$);
    set(markBootstrapLocaleInitStarted$);
    set(setRootSignal$, signal);
    // Claims `clerkUser$` in this synchronous pass. The daemons and route
    // setups below read it, and without an owner it never settles.
    const clerkIdentityDaemon = set(setupClerkUser$, signal);
    const apiBaseUrl = resolveApiBaseForTarget("api");
    const vercelProtectionBypass =
      getCapturedPreviewBypassForTarget(apiBaseUrl);
    const clerk = get(clerk$);
    set(setApiClientRuntime$, {
      getToken: async (requestSignal) => {
        const resolvedClerk = await clerk;
        requestSignal.throwIfAborted();
        return await readClerkToken(resolvedClerk, requestSignal);
      },
      apiBaseUrl,
      oauthApiBaseUrl: resolveOAuthApiBase(),
      ...(vercelProtectionBypass ? { vercelProtectionBypass } : {}),
    });
    set(initBootstrapSkeleton$);
    set(setupLoggers$);

    // Feature switches start from repository defaults until the API responds.
    // Install diagnostics before authenticated services so an enabled default
    // can capture their initial Clerk and Ably waits.
    set(setupConnectionDiagnostics$, signal);
    set(writeConnectionDiagnostic$, {
      action: "set-enabled",
      enabled: get(featureSwitch$)[FeatureSwitchKey.OkouDebug] ?? false,
    });

    // Keep failures that happen before the first React render observable.
    set(listenSharedWorkerFailure$, signal);
    const sharedDatabaseDaemon = isDesktopAuthFlow()
      ? Promise.resolve()
      : set(setupSharedDatabaseBridge$, signal);
    const authenticatedRealtimeDaemon = isDesktopAuthFlow()
      ? Promise.resolve()
      : set(runAuthenticatedRealtime$, signal);
    const ready = set(completeBootstrap$, render, signal);

    return {
      authenticatedRealtimeDaemon,
      clerkIdentityDaemon,
      ready,
      sharedDatabaseDaemon,
    };
  },
);
