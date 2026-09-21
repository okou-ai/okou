// Source-first onboarding funnel analytics. The `Onboarding: ` prefix is its
// own: `PaidOnboarding: ` stays reserved for the paid funnel's dashboards.
//
// Nothing a person typed is captured here. Invite addresses, catalog search
// words and the starting prompt itself never leave the browser; the funnel
// carries counts, lengths, connector slugs and the enum answers instead.
import { command, state } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";
import { captureOnboardingEvent } from "../../lib/posthog.ts";
import {
  sourcesFirstDraft$,
  sourcesFirstFlow$,
  sourcesFirstSteps,
  type ChatChannelId,
  type SourcesFirstStep,
  type SubscriptionProvider,
} from "../onboarding/onboarding-sources-first-state.ts";

type TelemetryProperties = Record<string, string | number | boolean>;

/** Which control started a connect, so the grid and the catalog stay apart. */
type SourceConnectOrigin = "grid" | "search";

/**
 * Every event carries where in this run it happened. The step list is the
 * run's own branch, so `step_index` and `step_count` describe the flow the
 * person is actually walking rather than every step the flow can have.
 */
const captureStepEvent$ = command(
  (
    { get },
    step: SourcesFirstStep,
    name: string,
    properties: TelemetryProperties = {},
  ): void => {
    const flow = get(sourcesFirstFlow$);
    const steps = sourcesFirstSteps(flow, get(sourcesFirstDraft$).experienced);
    captureOnboardingEvent(name, {
      flow: "source_first",
      step_key: step,
      step_index: steps.indexOf(step),
      step_count: steps.length,
      route_path: window.location.pathname,
      is_owner: flow === "owner",
      ...properties,
    });
  },
);

export const captureSourceOnboardingStepViewed$ = command(
  ({ set }, step: SourcesFirstStep): void => {
    set(captureStepEvent$, step, "StepViewed");
  },
);

export const captureSourceOnboardingBack$ = command(
  ({ set }, step: SourcesFirstStep): void => {
    set(captureStepEvent$, step, "Back");
  },
);

export const captureSourceOnboardingSkipped$ = command(
  ({ set }, step: SourcesFirstStep): void => {
    set(captureStepEvent$, step, "Skip");
  },
);

export const captureSourceOnboardingIndustrySelected$ = command(
  ({ set }, industry: OnboardingIndustry): void => {
    set(captureStepEvent$, "industry", "IndustrySelected", { industry });
  },
);

/** The control a connect came from, kept until that connect succeeds. */
const internalConnectStart$ = state<{
  readonly connectorSlug: ConnectorSlug;
  readonly origin: SourceConnectOrigin;
} | null>(null);

export const captureSourceOnboardingConnectStarted$ = command(
  (
    { set },
    connectorSlug: ConnectorSlug,
    origin: SourceConnectOrigin,
  ): void => {
    set(internalConnectStart$, { connectorSlug, origin });
    set(captureStepEvent$, "sources", "SourceConnectStarted", {
      connector_slug: connectorSlug,
      source_origin: origin,
    });
  },
);

export const captureSourceOnboardingConnected$ = command(
  ({ get, set }, connectorSlug: ConnectorSlug): void => {
    const started = get(internalConnectStart$);
    set(captureStepEvent$, "sources", "SourceConnected", {
      connector_slug: connectorSlug,
      // A connect that finished without a start of this run, for example one
      // returning from a provider after a reload, is reported as such rather
      // than credited to whichever control was used last.
      source_origin:
        started?.connectorSlug === connectorSlug ? started.origin : "unknown",
    });
  },
);

export const captureSourceOnboardingCatalogSearchOpened$ = command(
  ({ set }): void => {
    set(captureStepEvent$, "sources", "CatalogSearchOpened");
  },
);

export const captureSourceOnboardingCatalogSearchResultSelected$ = command(
  ({ set }, connectorSlug: ConnectorSlug, resultCount: number): void => {
    set(captureStepEvent$, "sources", "CatalogSearchResultSelected", {
      connector_slug: connectorSlug,
      result_count: resultCount,
    });
  },
);

export const captureSourceOnboardingInviteAdded$ = command(
  ({ set }, inviteCount: number): void => {
    set(captureStepEvent$, "team", "InviteAdded", {
      invite_count: inviteCount,
    });
  },
);

export const captureSourceOnboardingExperienceAnswered$ = command(
  (
    { set },
    experienced: boolean,
    provider: SubscriptionProvider | null,
  ): void => {
    set(captureStepEvent$, "experience", "ExperienceAnswered", {
      experienced,
      provider: provider ?? "none",
    });
  },
);

export const captureSourceOnboardingSlackInstallStarted$ = command(
  ({ set }): void => {
    set(captureStepEvent$, "slack", "SlackInstallStarted");
  },
);

export const captureSourceOnboardingChannelClicked$ = command(
  ({ set }, channel: ChatChannelId, added: boolean): void => {
    set(captureStepEvent$, "slack", "ChannelClicked", { channel, added });
  },
);

/**
 * One `PromptEdited` per run: the funnel asks whether the request was touched
 * before it was started, not how many keystrokes it took.
 */
const internalPromptEdited$ = state(false);

export const captureSourceOnboardingPromptEdited$ = command(
  ({ get, set }, promptLength: number): void => {
    if (get(internalPromptEdited$)) {
      return;
    }
    set(internalPromptEdited$, true);
    set(captureStepEvent$, "ready", "PromptEdited", {
      prompt_edited: true,
      prompt_length: promptLength,
    });
  },
);

export const captureSourceOnboardingStartClicked$ = command(
  ({ get, set }, promptLength: number): void => {
    set(captureStepEvent$, "ready", "StartClicked", {
      prompt_edited: get(internalPromptEdited$),
      prompt_length: promptLength,
    });
  },
);
