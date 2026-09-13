import { isDesktopAuthFlow } from "./desktop-auth-flow.ts";
import { command, state } from "ccstate";
import { posthog, type CaptureResult } from "posthog-js/dist/module.slim";
import { isStandalonePwa } from "./keyboard-dismiss-gesture.ts";
import { resolvePlatformRuntimeConfig } from "./platform-host.ts";

const RUNTIME_CONFIG = resolvePlatformRuntimeConfig();
const POSTHOG_HOST = RUNTIME_CONFIG.postHogHost;
const POSTHOG_KEY = RUNTIME_CONFIG.postHogKey;

const APP_FIRST_SKELETON_PAINT_EVENT = "app_first_skeleton_paint";
const APP_FIRST_SKELETON_PAINT_DISTINCT_ID = "app-bootstrap";

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function sanitizePostHogCaptureResult(
  captureResult: CaptureResult | null,
): CaptureResult | null {
  if (captureResult === null || isDesktopAuthFlow()) {
    return null;
  }
  if (captureResult.event === APP_FIRST_SKELETON_PAINT_EVENT) {
    const properties = captureResult.properties;
    const sanitizedProperties: Record<string, boolean | number | string> = {
      $process_person_profile: false,
      distinct_id: APP_FIRST_SKELETON_PAINT_DISTINCT_ID,
      paint_metric: "first-contentful-paint",
      public_brand: RUNTIME_CONFIG.publicBrand,
      token: POSTHOG_KEY ?? "",
    };
    for (const name of [
      "navigation_response_end_ms",
      "navigation_response_start_ms",
      "response_end_to_skeleton_paint_ms",
      "skeleton_paint_ms",
    ]) {
      const value = finiteNonNegativeNumber(properties[name]);
      if (value !== undefined) {
        sanitizedProperties[name] = value;
      }
    }
    return {
      event: APP_FIRST_SKELETON_PAINT_EVENT,
      properties: sanitizedProperties,
      ...(captureResult.timestamp
        ? { timestamp: captureResult.timestamp }
        : {}),
      uuid: captureResult.uuid,
    };
  }
  return captureResult;
}

function runPostHog(action: (key: string, host: string) => void): void {
  if (!POSTHOG_KEY || !POSTHOG_HOST || isDesktopAuthFlow()) {
    return;
  }
  action(POSTHOG_KEY, POSTHOG_HOST);
}

export function initPostHog(): void {
  runPostHog((key, host) => {
    posthog.init(key, {
      // First-party reverse proxy (Cloudflare-fronted): forwards /static assets,
      // /flags, ingest and replay (/s) to PostHog US so ad blockers do not drop
      // events. Shared with the marketing site through one ingest domain.
      api_host: host,
      ui_host: "https://us.posthog.com",
      autocapture: false,
      capture_pageview: false,
      before_send: sanitizePostHogCaptureResult,
      disable_session_recording: true,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
      },
      persistence: "localStorage+cookie",
      sanitize_properties(properties, _event) {
        if (properties?.$current_url) {
          properties["$current_url"] = properties["$current_url"].replace(
            /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
            "/:id",
          );
        }
        return { ...properties, public_brand: RUNTIME_CONFIG.publicBrand };
      },
    });
  });
}

function navigationTimingEntry(): PerformanceNavigationTiming | undefined {
  return performance
    .getEntriesByType("navigation")
    .find((entry): entry is PerformanceNavigationTiming => {
      return (
        entry.entryType === "navigation" &&
        "responseStart" in entry &&
        "responseEnd" in entry
      );
    });
}

function firstContentfulPaintTime(): number | undefined {
  return performance.getEntriesByType("paint").find((entry) => {
    return entry.name === "first-contentful-paint";
  })?.startTime;
}

/**
 * Capture an anonymous, allowlisted measurement of the navigation response and
 * the first frame that can contain the inline bootstrap skeleton.
 */
export function captureFirstSkeletonPaint(): void {
  const navigation = navigationTimingEntry();
  if (!navigation) {
    return;
  }
  const responseStart = finiteNonNegativeNumber(navigation.responseStart);
  const responseEnd = finiteNonNegativeNumber(navigation.responseEnd);
  const skeletonPaint = finiteNonNegativeNumber(firstContentfulPaintTime());
  if (
    responseStart === undefined ||
    responseEnd === undefined ||
    skeletonPaint === undefined ||
    responseEnd < responseStart ||
    skeletonPaint < responseEnd
  ) {
    return;
  }

  runPostHog(() => {
    posthog.capture(APP_FIRST_SKELETON_PAINT_EVENT, {
      navigation_response_end_ms: Math.round(responseEnd),
      navigation_response_start_ms: Math.round(responseStart),
      paint_metric: "first-contentful-paint",
      response_end_to_skeleton_paint_ms: Math.round(
        skeletonPaint - responseEnd,
      ),
      skeleton_paint_ms: Math.round(skeletonPaint),
    });
  });
}

interface PostHogUser {
  id: string;
  email: string | undefined;
  name: string | undefined;
}

export function setPostHogUser(user: PostHogUser): void {
  runPostHog(() => {
    posthog.identify(user.id, { email: user.email, name: user.name });
  });
}

/**
 * Register first-touch acquisition fields as super properties so product
 * events, including task completion, retain the campaign and ad group that
 * brought the user into the app.
 */
export function registerPostHogAttribution(
  properties: Record<string, string>,
): void {
  runPostHog(() => {
    posthog.register(properties);
  });
}

/** Keep product events joinable to the billing organization. */
export function setPostHogOrganization(orgId: string | undefined): void {
  runPostHog(() => {
    if (orgId) {
      posthog.register({ org_id: orgId });
    } else {
      posthog.unregister("org_id");
    }
  });
}

export function clearPostHogUser(): void {
  runPostHog(() => {
    posthog.reset();
  });
}

export function captureTaskCompletedSuccessfully(): void {
  runPostHog(() => {
    posthog.capture("task_completed_successfully", { surface: "chat_thread" });
  });
}

export type ChatThreadMetadataShortcutOutcome =
  | "hit"
  | "not-found"
  | "transport-failure";

export const captureChatThreadMetadataShortcut$ = command(
  (_, outcome: ChatThreadMetadataShortcutOutcome): void => {
    runPostHog(() => {
      posthog.capture("chat_thread_metadata_shortcut", { outcome });
    });
  },
);

/**
 * Paid-onboarding funnel events. The `PaidOnboarding: ` prefix is load-bearing:
 * the acquisition dashboards and Google Ads reconciliation both key off it.
 */
export function capturePaidOnboardingEvent(
  name: string,
  properties: Record<string, string | number | boolean>,
): void {
  runPostHog(() => {
    posthog.capture(`PaidOnboarding: ${name}`, properties);
  });
}

// ── Navigation timing (ccstate-based) ──────────────────────────────
//
// Timing marks are ccstate signals so they compose naturally with the
// existing signal graph. A new startChatNavigationTiming$ call
// overwrites the previous timing — no AbortController or timeout needed.

const navigationEnterTime$ = state<number | null>(null);
const navigationPushStateTime$ = state<number | null>(null);
const navigationSetupTime$ = state<number | null>(null);

export const startChatNavigationTiming$ = command(({ set }) => {
  runPostHog(() => {
    set(navigationEnterTime$, performance.now());
    set(navigationPushStateTime$, null);
    set(navigationSetupTime$, null);
  });
});

export const markNavigationPushState$ = command(({ get, set }) => {
  if (get(navigationEnterTime$) === null) {
    return;
  }
  runPostHog(() => {
    set(navigationPushStateTime$, performance.now());
  });
});

export const markRouteSetupBegin$ = command(({ get, set }) => {
  if (get(navigationEnterTime$) === null) {
    return;
  }
  runPostHog(() => {
    set(navigationSetupTime$, performance.now());
  });
});

export const captureNavigationTiming$ = command(({ get, set }) => {
  const enterTime = get(navigationEnterTime$);
  if (enterTime === null) {
    return;
  }
  runPostHog(() => {
    const now = performance.now();
    const pushStateTime = get(navigationPushStateTime$);
    const setupTime = get(navigationSetupTime$);
    posthog.capture("chat_navigation_timing", {
      total_ms: Math.round(now - enterTime),
      push_state_ms:
        pushStateTime !== null
          ? Math.round(pushStateTime - enterTime)
          : undefined,
      setup_begin_ms:
        setupTime !== null ? Math.round(setupTime - enterTime) : undefined,
    });
    set(navigationEnterTime$, null);
    set(navigationPushStateTime$, null);
    set(navigationSetupTime$, null);
  });
});

export function capturePageView(): void {
  runPostHog(() => {
    posthog.capture("$pageview");
  });
}

const BOOTSTRAP_PHASE_TIMING_EVENT = "app_bootstrap_phase_timing";

type BootstrapThreadMetadataSource =
  | "local"
  | "memory"
  | "not_found"
  | "remote";

interface BootstrapPhaseTimingState {
  readonly finalRoute?: string;
  readonly initialRoute?: string;
  readonly localeInitDurationMs?: number;
  readonly localeInitStartedAt?: number;
  readonly localThreadMetadataDurationMs?: number;
  readonly remoteThreadMetadataDurationMs?: number;
  readonly routeSetupStartedAt?: number;
  readonly threadMetadataSource?: BootstrapThreadMetadataSource;
}

const bootstrapPhaseTimingState$ = state<BootstrapPhaseTimingState | null>(
  null,
);
const bootstrapPhaseTimingReported$ = state(false);

export const initBootstrapPhaseTiming$ = command(({ set }) => {
  set(bootstrapPhaseTimingState$, {});
});

export const markBootstrapLocaleInitStarted$ = command(({ get, set }) => {
  const current = get(bootstrapPhaseTimingState$);
  if (!current || current.localeInitStartedAt !== undefined) {
    return;
  }
  set(bootstrapPhaseTimingState$, {
    ...current,
    localeInitStartedAt: performance.now(),
  });
});

export const markBootstrapLocaleInitCompleted$ = command(({ get, set }) => {
  const current = get(bootstrapPhaseTimingState$);
  if (
    !current ||
    current.localeInitStartedAt === undefined ||
    current.localeInitDurationMs !== undefined
  ) {
    return;
  }
  set(bootstrapPhaseTimingState$, {
    ...current,
    localeInitDurationMs: Math.round(
      performance.now() - current.localeInitStartedAt,
    ),
  });
});

export const markBootstrapRouteSetup$ = command(
  ({ get, set }, route: string) => {
    const current = get(bootstrapPhaseTimingState$);
    if (!current) {
      return;
    }
    set(bootstrapPhaseTimingState$, {
      ...current,
      finalRoute: route,
      initialRoute: current.initialRoute ?? route,
      localThreadMetadataDurationMs: undefined,
      remoteThreadMetadataDurationMs: undefined,
      routeSetupStartedAt: current.routeSetupStartedAt ?? performance.now(),
      threadMetadataSource: undefined,
    });
  },
);

export const recordBootstrapThreadMetadataTiming$ = command(
  (
    { get, set },
    timing: {
      readonly localDurationMs?: number;
      readonly remoteDurationMs?: number;
      readonly source: BootstrapThreadMetadataSource;
    },
  ) => {
    const current = get(bootstrapPhaseTimingState$);
    if (!current) {
      return;
    }
    set(bootstrapPhaseTimingState$, {
      ...current,
      localThreadMetadataDurationMs: timing.localDurationMs,
      remoteThreadMetadataDurationMs: timing.remoteDurationMs,
      threadMetadataSource: timing.source,
    });
  },
);

function elapsedDuration(
  startedAt: number | undefined,
  completedAt: number | undefined,
): number | undefined {
  if (
    startedAt === undefined ||
    completedAt === undefined ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt
  ) {
    return undefined;
  }
  return Math.round(completedAt - startedAt);
}

function setDurationProperty(
  properties: Record<string, string | number | boolean>,
  name: string,
  durationMs: number | undefined,
): void {
  if (durationMs !== undefined) {
    properties[name] = durationMs;
  }
}

export const captureBootstrapPhaseTiming$ = command(({ get, set }) => {
  if (get(bootstrapPhaseTimingReported$)) {
    return;
  }
  set(bootstrapPhaseTimingReported$, true);

  runPostHog(() => {
    const capturedAt = performance.now();
    const current = get(bootstrapPhaseTimingState$);
    const entryModuleReadyDurationMs = elapsedDuration(
      window.__appBootstrapStart,
      window.__appBootstrapModuleReady,
    );
    const routeSetupDurationMs = elapsedDuration(
      current?.routeSetupStartedAt,
      capturedAt,
    );
    const properties: Record<string, string | number | boolean> = {
      final_route: current?.finalRoute ?? "unknown",
      initial_route: current?.initialRoute ?? "unknown",
      standalone_pwa: isStandalonePwa(),
    };
    setDurationProperty(
      properties,
      "entry_module_ready_ms",
      entryModuleReadyDurationMs,
    );
    setDurationProperty(
      properties,
      "skeleton_duration_ms",
      elapsedDuration(window.__appBootstrapStart, capturedAt),
    );
    setDurationProperty(
      properties,
      "locale_init_ms",
      current?.localeInitDurationMs,
    );
    setDurationProperty(properties, "route_setup_ms", routeSetupDurationMs);
    setDurationProperty(
      properties,
      "local_thread_metadata_ms",
      current?.localThreadMetadataDurationMs,
    );
    setDurationProperty(
      properties,
      "remote_thread_metadata_ms",
      current?.remoteThreadMetadataDurationMs,
    );
    if (current?.threadMetadataSource !== undefined) {
      properties.thread_metadata_source = current.threadMetadataSource;
    }
    posthog.capture(BOOTSTRAP_PHASE_TIMING_EVENT, properties);
  });
});

const firstSkeletonHideReported$ = state(false);

/**
 * Report the time elapsed from the inline `__appBootstrapStart` mark in
 * `index.html` to the first `hideAppSkeleton$` invocation. Captures the
 * total perceived bootstrap duration (HTML parse start → first real content).
 * No-op after the first call.
 */
export const captureFirstSkeletonHide$ = command(({ get, set }) => {
  if (get(firstSkeletonHideReported$)) {
    return;
  }
  set(firstSkeletonHideReported$, true);

  runPostHog(() => {
    const startMark = window.__appBootstrapStart;
    if (typeof startMark !== "number") {
      return;
    }
    posthog.capture("app_first_skeleton_hide", {
      duration_ms: Math.round(performance.now() - startMark),
    });
  });
});

interface RecommendedFollowupTelemetryItem {
  readonly kind: string;
  readonly generationType?: string;
}

function recommendedFollowupGenerationTypes(
  followups: readonly RecommendedFollowupTelemetryItem[],
): string[] {
  return followups.flatMap((followup) => {
    return followup.generationType ? [followup.generationType] : [];
  });
}

export function captureRecommendedFollowupsShown(args: {
  readonly messageId: string;
  readonly followups: readonly RecommendedFollowupTelemetryItem[];
}): void {
  runPostHog(() => {
    posthog.capture("chat_recommended_followups_shown", {
      assistant_message_id: args.messageId,
      followup_count: args.followups.length,
      followup_kinds: args.followups.map((followup) => {
        return followup.kind;
      }),
      generation_types: recommendedFollowupGenerationTypes(args.followups),
    });
  });
}

export function captureRecommendedFollowupSelected(args: {
  readonly messageId: string;
  readonly followupIndex: number;
  readonly followupCount: number;
  readonly followup: RecommendedFollowupTelemetryItem;
}): void {
  runPostHog(() => {
    posthog.capture("chat_recommended_followup_selected", {
      assistant_message_id: args.messageId,
      followup_index: args.followupIndex,
      followup_count: args.followupCount,
      followup_kind: args.followup.kind,
      generation_type: args.followup.generationType,
    });
  });
}

export function captureChatWorkHistoryExpanded(args: {
  readonly workStatus: "active" | "completed";
}): void {
  runPostHog(() => {
    posthog.capture("chat_work_history_expanded", {
      work_status: args.workStatus,
    });
  });
}
