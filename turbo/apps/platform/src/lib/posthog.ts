import { BILLING_FEEDBACK_SURVEYS } from "@okouai/core/billing-feedback";
import type { SuggestionPreset } from "@okouai/api-contracts/validators/chat-threads";
import { command, state } from "ccstate";
import { posthog, type CaptureResult } from "posthog-js/dist/module.slim";
import type { Survey } from "posthog-js";
import {
  buildSurveyResponseProperties,
  getSurveyInteractionProperty,
  getSurveyResponseKey,
} from "@posthog/core/surveys";
import { SurveysExtensions } from "posthog-js/dist/extension-bundles";
import { isStandalonePwa } from "./keyboard-dismiss-gesture.ts";
import { resolvePlatformRuntimeConfig } from "./platform-host.ts";
import { redactProofUrl } from "./redact-proof-url.ts";
import type { ArtifactDownloadType } from "./artifact-download-type.ts";

const RUNTIME_CONFIG = resolvePlatformRuntimeConfig();
const POSTHOG_HOST = RUNTIME_CONFIG.postHogHost;
const POSTHOG_KEY = RUNTIME_CONFIG.postHogKey;

const BILLING_FEEDBACK_SEEN_USER = "billing_feedback_seen_user_id";

const APP_FIRST_SKELETON_PAINT_EVENT = "app_first_skeleton_paint";
const APP_FIRST_SKELETON_PAINT_DISTINCT_ID = "app-bootstrap";

function redactProofUrlProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([name, value]) => {
      if (typeof value === "string") {
        return [name, redactProofUrl(value)];
      }
      // PostHog emits person properties both here and at the envelope level.
      if (
        (name === "$set" || name === "$set_once") &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return [
          name,
          redactProofUrlProperties(value as Record<string, unknown>),
        ];
      }
      return [name, value];
    }),
  );
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function sanitizePostHogCaptureResult(
  captureResult: CaptureResult | null,
): CaptureResult | null {
  if (captureResult === null) {
    return null;
  }
  if (captureResult.event === APP_FIRST_SKELETON_PAINT_EVENT) {
    const properties = captureResult.properties;
    const sanitizedProperties: Record<string, boolean | number | string> = {
      $process_person_profile: false,
      distinct_id: APP_FIRST_SKELETON_PAINT_DISTINCT_ID,
      paint_metric: "first-contentful-paint",
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
  return {
    ...captureResult,
    properties: redactProofUrlProperties(captureResult.properties),
    ...(captureResult.$set
      ? { $set: redactProofUrlProperties(captureResult.$set) }
      : {}),
    ...(captureResult.$set_once
      ? { $set_once: redactProofUrlProperties(captureResult.$set_once) }
      : {}),
  };
}

function runPostHog(action: (key: string, host: string) => void): void {
  if (!POSTHOG_KEY || !POSTHOG_HOST) {
    return;
  }
  action(POSTHOG_KEY, POSTHOG_HOST);
}

export function initPostHog(): void {
  runPostHog((key, host) => {
    posthog.init(key, {
      // The slim SDK requires the survey and targeting-flag extensions explicitly.
      __extensionClasses: SurveysExtensions,
      // First-party reverse proxy (Cloudflare-fronted): forwards /static assets,
      // /flags, ingest and replay (/s) to PostHog US so ad blockers do not drop
      // events. Shared with the marketing site through one ingest domain.
      api_host: host,
      ui_host: "https://us.posthog.com",
      autocapture: false,
      capture_pageview: false,
      before_send(captureResult) {
        if (
          captureResult?.event === "survey shown" &&
          Object.values(BILLING_FEEDBACK_SURVEYS).some((surveyId) => {
            return surveyId === captureResult.properties.$survey_id;
          })
        ) {
          // Count an actual impression, including a dismissal without an answer.
          // The person-level PostHog targeting rule covers subsequent devices.
          posthog.register({
            [BILLING_FEEDBACK_SEEN_USER]: posthog.get_distinct_id(),
          });
          for (const surveyId of Object.values(BILLING_FEEDBACK_SURVEYS)) {
            posthog.surveys?.markSurveyAsSeen(surveyId);
          }
        }
        return sanitizePostHogCaptureResult(captureResult);
      },
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
        return properties;
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

type ArtifactAction =
  | {
      readonly action: "download";
      readonly artifact_type: ArtifactDownloadType;
      readonly surface:
        | "dialog"
        | "page"
        | "file_preview"
        | "attachment_chip"
        | "shared_preview"
        | "diagram_preview"
        | "inline_table";
    }
  | {
      readonly action: "markdown_export";
      readonly surface: "dialog" | "page";
      readonly format: "pdf" | "docx";
    }
  | {
      readonly action: "google_drive_sync";
      readonly surface: "dialog" | "page" | "inline_table";
      readonly target: "file" | "document" | "spreadsheet" | "presentation";
    }
  | {
      readonly action: "banner_share";
      readonly surface: "dialog" | "sidebar";
      readonly target: "hosted_site";
      readonly show_banner: boolean | "unknown";
    };

/** Capture user intent before authorization or transfer; never include file data. */
export function captureArtifactAction(properties: ArtifactAction): void {
  runPostHog(() => {
    posthog.capture("artifact_action_clicked", properties);
  });
}

export type ChatThreadMetadataShortcutOutcome =
  "hit" | "not-found" | "transport-failure";

export const captureChatThreadMetadataShortcut$ = command(
  (_, outcome: ChatThreadMetadataShortcutOutcome): void => {
    runPostHog(() => {
      posthog.capture("chat_thread_metadata_shortcut", { outcome });
    });
  },
);

/**
 * Paid-onboarding product events. The `PaidOnboarding: ` prefix is load-bearing
 * for the existing product analytics dashboards.
 */
export function capturePaidOnboardingEvent(
  name: string,
  properties: Record<string, string | number | boolean>,
): void {
  runPostHog(() => {
    posthog.capture(`PaidOnboarding: ${name}`, properties);
  });
}

/**
 * Source-first onboarding product events. A prefix of its own, so the
 * `PaidOnboarding: ` dashboards keep counting only the flow they were built
 * for.
 */
export function captureOnboardingEvent(
  name: string,
  properties: Record<string, string | number | boolean>,
): void {
  runPostHog(() => {
    posthog.capture(`Onboarding: ${name}`, properties);
  });
}

export function captureSubscriptionLinkingEvent(
  name: "entry_clicked" | "provider_selected",
  source:
    "composer_model_slot" | "composer_model_panel" | "account_menu" | "me_page",
  provider?: "codex-oauth-token" | "claude-code-oauth-token",
): void {
  runPostHog(() => {
    posthog.capture(`SubscriptionLinking: ${name}`, {
      source,
      ...(provider ? { provider } : {}),
    });
  });
}

export function capturePageView(): void {
  runPostHog(() => {
    posthog.capture("$pageview");
  });
}

const BOOTSTRAP_PHASE_TIMING_EVENT = "app_bootstrap_phase_timing";

type BootstrapThreadMetadataResolutionPath =
  | "after-cache-hydration"
  | "canonical-event-stream"
  | "canonical-not-found"
  | "current-projection"
  | "metadata-shortcut";

type LegacyBootstrapThreadMetadataSource =
  "local" | "memory" | "not_found" | "remote";

// Preserve the existing PostHog schema while runtime names describe lookup semantics.
const legacyBootstrapThreadMetadataSourceByResolutionPath = {
  "after-cache-hydration": "local",
  "canonical-event-stream": "remote",
  "canonical-not-found": "not_found",
  "current-projection": "memory",
  "metadata-shortcut": "remote",
} satisfies Record<
  BootstrapThreadMetadataResolutionPath,
  LegacyBootstrapThreadMetadataSource
>;

interface BootstrapPhaseTimingState {
  readonly finalRoute?: string;
  readonly initialRoute?: string;
  readonly localeInitDurationMs?: number;
  readonly localeInitStartedAt?: number;
  readonly routeSetupStartedAt?: number;
  readonly threadMetadataCacheHydrationWaitMs?: number;
  readonly threadMetadataCacheMissResolutionMs?: number;
  readonly threadMetadataResolutionPath?: BootstrapThreadMetadataResolutionPath;
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
      routeSetupStartedAt: current.routeSetupStartedAt ?? performance.now(),
      threadMetadataCacheHydrationWaitMs: undefined,
      threadMetadataCacheMissResolutionMs: undefined,
      threadMetadataResolutionPath: undefined,
    });
  },
);

export const recordBootstrapThreadMetadataTiming$ = command(
  (
    { get, set },
    timing: {
      readonly cacheHydrationWaitMs?: number;
      readonly cacheMissResolutionMs?: number;
      readonly resolutionPath: BootstrapThreadMetadataResolutionPath;
    },
  ) => {
    const current = get(bootstrapPhaseTimingState$);
    if (!current) {
      return;
    }
    set(bootstrapPhaseTimingState$, {
      ...current,
      threadMetadataCacheHydrationWaitMs: timing.cacheHydrationWaitMs,
      threadMetadataCacheMissResolutionMs: timing.cacheMissResolutionMs,
      threadMetadataResolutionPath: timing.resolutionPath,
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
      current?.threadMetadataCacheHydrationWaitMs,
    );
    setDurationProperty(
      properties,
      "remote_thread_metadata_ms",
      current?.threadMetadataCacheMissResolutionMs,
    );
    if (current?.threadMetadataResolutionPath !== undefined) {
      properties.thread_metadata_source =
        legacyBootstrapThreadMetadataSourceByResolutionPath[
          current.threadMetadataResolutionPath
        ];
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
  readonly threadId: string;
  readonly messageId: string;
  readonly layout: "rows" | "quick-reply-rail";
  readonly followups: readonly RecommendedFollowupTelemetryItem[];
}): void {
  runPostHog(() => {
    posthog.capture("chat_recommended_followups_shown", {
      chat_thread_id: args.threadId,
      assistant_message_id: args.messageId,
      followup_layout: args.layout,
      followup_count: args.followups.length,
      workflow_followup_count: args.followups.filter((followup) => {
        return followup.kind === "workflow";
      }).length,
      email_followup_count: args.followups.filter((followup) => {
        return followup.kind === "email";
      }).length,
      followup_kinds: args.followups.map((followup) => {
        return followup.kind;
      }),
      generation_types: recommendedFollowupGenerationTypes(args.followups),
    });
  });
}

export function captureRecommendedFollowupSelected(args: {
  readonly threadId: string;
  readonly messageId: string;
  readonly layout: "rows" | "quick-reply-rail";
  readonly followupIndex: number;
  readonly followupCount: number;
  readonly followup: RecommendedFollowupTelemetryItem;
}): void {
  runPostHog(() => {
    posthog.capture("chat_recommended_followup_selected", {
      chat_thread_id: args.threadId,
      assistant_message_id: args.messageId,
      followup_layout: args.layout,
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

export type SuggestionImpression = Pick<
  SuggestionPreset,
  "suggestion_id" | "impression_id"
>;
export type SuggestionFeedbackKind =
  | "already_done"
  | "not_planned"
  | "dont_nudge"
  | "less_like_this"
  | "dismissed";
export type SuggestionDirection =
  | (SuggestionImpression & { direction_type: "custom" })
  | (SuggestionPreset & { direction_type: "preset" });

type SuggestionEvent =
  | {
      eventName: "suggestion_card_shown";
      properties: SuggestionImpression & {
        option_ids: string[];
        option_count: number;
      };
    }
  | {
      eventName: "suggestion_card_action_clicked";
      properties:
        | (SuggestionImpression & { action: "view_source" | "open_custom" })
        | (SuggestionPreset & { action: "select_option" });
    }
  | {
      eventName: "suggestion_card_feedback_recorded";
      properties: SuggestionImpression & {
        feedback_kind: SuggestionFeedbackKind;
        operation: "apply" | "undo";
      };
    }
  | {
      eventName: "suggestion_card_message_sent";
      properties: SuggestionDirection;
    };

export function captureSuggestionCard(
  { eventName, properties }: SuggestionEvent,
  eventId?: string,
): void {
  runPostHog(() => {
    posthog.capture(
      eventName,
      { surface: "home_suggestions", ...properties },
      eventId ? { uuid: eventId } : undefined,
    );
  });
}

export function captureBillingFunnelEvent(
  event:
    | "billing_upgrade_dialog_opened"
    | "billing_upgrade_dialog_closed"
    | "billing_checkout_started"
    | "billing_checkout_canceled"
    | "billing_purchase_completed",
  properties: Record<string, unknown>,
): void {
  runPostHog(() => {
    posthog.capture(event, properties);
  });
}

/** Use the SDK's display rules for both the entry point and the popover. */
export function watchBillingFeedbackSurvey(
  surveyId: string,
  onAvailability: (survey: Survey | null) => void,
  signal: AbortSignal,
): void {
  if (signal.aborted) {
    return;
  }
  runPostHog(() => {
    let queryInFlight = false;
    let surveysReady = false;
    let flagsReady = false;
    const requestWhenReady = () => {
      if (signal.aborted || queryInFlight || !surveysReady || !flagsReady) {
        return;
      }
      queryInFlight = true;
      posthog.getActiveMatchingSurveys((surveys) => {
        queryInFlight = false;
        if (signal.aborted) {
          return;
        }
        const seen =
          posthog.get_property(BILLING_FEEDBACK_SEEN_USER) ===
          posthog.get_distinct_id();
        onAvailability(
          surveysReady && flagsReady && !seen
            ? (surveys.find((survey) => {
                return (
                  survey.id === surveyId &&
                  survey.questions.length === 1 &&
                  survey.questions[0]?.type === "single_choice" &&
                  Boolean(survey.questions[0].id)
                );
              }) ?? null)
            : null,
        );
      }, true);
    };
    const unsubscribeSurveys = posthog.onSurveysLoaded((_surveys, context) => {
      surveysReady = context?.isLoaded === true;
      if (!surveysReady) {
        onAvailability(null);
      }
      requestWhenReady();
    });
    // A Stripe return can first see cached anonymous flags, then identified flags.
    const unsubscribeFlags = posthog.onFeatureFlags(
      (_flags, _variants, context) => {
        flagsReady = context?.errorsLoading !== true;
        if (!flagsReady) {
          onAvailability(null);
        }
        requestWhenReady();
      },
    );
    const unsubscribeEvents = posthog.on(
      "eventCaptured",
      (event: CaptureResult) => {
        if (
          event.event === "survey shown" ||
          event.event === "survey sent" ||
          event.event === "survey dismissed"
        ) {
          requestWhenReady();
        }
      },
    );
    signal.addEventListener(
      "abort",
      () => {
        unsubscribeSurveys();
        unsubscribeFlags();
        unsubscribeEvents();
      },
      { once: true },
    );
  });
}

/** Use PostHog's event schema for the application-rendered billing surveys. */
export function captureBillingFeedbackSurvey(
  event: "survey shown" | "survey sent" | "survey dismissed",
  {
    survey,
    language,
    properties,
    submissionId,
  }: {
    readonly survey: Survey;
    readonly language: string | null;
    readonly properties: Record<string, unknown>;
    readonly submissionId: string;
  },
  response?: string,
): void {
  runPostHog(() => {
    const question = survey.questions[0];
    const responses =
      question?.id && response !== undefined
        ? buildSurveyResponseProperties(
            { [getSurveyResponseKey(question.id)]: response },
            {
              ...survey,
              questions: [{ ...question, originalQuestionIndex: 0 }],
            },
          )
        : {};
    posthog.capture(event, {
      ...properties,
      $survey_id: survey.id,
      $survey_name: survey.name,
      $survey_iteration: survey.current_iteration,
      $survey_iteration_start_date: survey.current_iteration_start_date,
      $survey_submission_id: submissionId,
      ...(language ? { $survey_language: language } : {}),
      ...responses,
      ...(event === "survey sent" ? { $survey_completed: true } : {}),
      ...(event === "survey dismissed"
        ? { $survey_partially_completed: false }
        : {}),
      ...(event !== "survey shown"
        ? {
            $set: {
              [getSurveyInteractionProperty(
                survey,
                event === "survey sent" ? "responded" : "dismissed",
              )]: true,
            },
          }
        : {}),
    });
  });
}
