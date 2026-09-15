import { command, computed, state } from "ccstate";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowAutomationsContract,
  workflowVisibilityContract,
  type ChatRunFinishedEventConfig,
  type GmailLabelAppliedEventConfig,
  type GmailNewMessageEventConfig,
  type GoogleCalendarAutomationEventConfig,
  type GoogleCalendarEventCancelledEventConfig,
  type GoogleCalendarEventCreatedEventConfig,
  type GoogleCalendarEventUpdatedEventConfig,
  type GoogleFormsResponseSubmittedEventCreateConfig,
  type GoogleMeetTranscriptGeneratedEventConfig,
  type GithubDeploymentStatusCreatedEventConfig,
  type GithubIssueCommentCreatedEventConfig,
  type GithubPullRequestAction,
  type GithubPullRequestEventConfig,
  type GithubPullRequestReviewSubmittedEventConfig,
  type GithubWorkflowJobCompletedEventConfig,
  type GithubWorkflowRunCompletedEventConfig,
  type NotionChildPageCreatedEventCreateConfig,
  type NotionDatabaseItemCreatedEventCreateConfig,
  type NotionPageContentUpdatedEventCreateConfig,
  type StripeInvoiceBillingReason,
  type WorkflowDetailResponse,
  type WorkflowSchedule,
  type WorkflowWebhookSecretResponse,
  type WorkflowSummary,
  type WorkflowAutomationsListEntry,
  type WorkflowAutomationCreateRequest,
  type WorkflowAutomationSummary,
  type WorkflowUpdateRequest,
  type WorkflowAutomationUpdateRequest,
} from "@okouai/api-contracts/contracts/workflows";
import { MORNING_BRIEF_OFFICIAL_DEFINITION_NAME } from "@okouai/api-contracts/contracts/morning-brief-preference";

import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { activeRoute$ } from "../active-route.ts";
import { locale$ } from "../locale.ts";
import {
  detachedNavigateTo$,
  pathParams$,
  replacePathSilently$,
  replaceSearchParams$,
  searchParams$,
} from "../route.ts";
import {
  isWorkflowDetailRouteKey,
  ROUTES,
  type RouteKey,
} from "../route-paths.ts";
import { currentAgentId$ } from "../agent.ts";
import { ensureDraft$ } from "../chat-page/create-chat-thread.ts";
import {
  reloadWorkflowData$,
  workflowReloadVersion$,
} from "./workflow-reload.ts";
import { onRef } from "../utils.ts";

type WorkflowDetailActionDialog = "copy" | "delete" | null;
export type WorkflowDetailTab = "automations" | "instructions" | "info";
export type WorkflowFilter =
  | "all"
  | "automated"
  | "without"
  | "private"
  | "public";
export type WorkflowSortMode = "next-run" | "alphabetical" | "created";
export interface WorkflowCopyFormState {
  readonly selectedAgentId: string | null;
  readonly removeOriginal: boolean;
}

type GmailTextField = "from" | "subject" | "body" | "to" | "cc";
export type GmailTextOperator = "contains" | "containsAny" | "doesNotContain";
export type GmailMatchField = GmailTextField | "threadId";
export type GmailMatchOperator = GmailTextOperator | "is";
export interface GmailMatchCondition {
  readonly field: GmailMatchField;
  readonly operator: GmailMatchOperator;
  readonly value: string;
}

function defaultGmailMatchConditions(): readonly GmailMatchCondition[] {
  return [{ field: "from", operator: "contains", value: "" }];
}

function defaultWorkflowCopyForm(): WorkflowCopyFormState {
  return {
    selectedAgentId: null,
    removeOriginal: false,
  };
}
export type WorkflowAutomationCreateDialog =
  | "chat-run-finished"
  | "interval"
  | "scheduled"
  | "once"
  | "gmail"
  | "gmail-label"
  | "github-pull-request"
  | "github-workflow-job"
  | "github-pull-request-review"
  | "github-deployment-status"
  | "github-issue-comment"
  | "github-workflow-run"
  | "google-calendar-created"
  | "google-calendar-updated"
  | "google-calendar-cancelled"
  | "google-forms"
  | "google-meet-transcript-generated"
  | "notion-child-page"
  | "notion-database-item"
  | "notion-page-content-updated"
  | "stripe-invoice-paid"
  | "webhook"
  | null;
export type NotionPageContentUpdatedScopeMode = "page" | "database";
type WorkflowAutomationCategoryKey =
  | "schedule"
  | "email"
  | "calendar"
  | "forms"
  | "notion"
  | "integrations";
type WorkflowWebhookAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { readonly kind: "event"; readonly eventType: "webhook-received" }
>;
export type GoogleCalendarWorkflowAutomationSummary = Extract<
  WorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType:
      | "google-calendar-event-created"
      | "google-calendar-event-updated"
      | "google-calendar-event-cancelled";
  }
>;
export type WorkflowAutomationEntry = WorkflowAutomationsListEntry;
const WORKFLOW_DETAIL_FILE_PARAM = "file";
const WORKFLOW_AUTOMATION_TARGET_PARAM = "automationId";

export function isGoogleCalendarWorkflowAutomation(
  automation: WorkflowAutomationSummary,
): automation is GoogleCalendarWorkflowAutomationSummary {
  return (
    automation.kind === "event" &&
    (automation.eventType === "google-calendar-event-created" ||
      automation.eventType === "google-calendar-event-updated" ||
      automation.eventType === "google-calendar-event-cancelled")
  );
}

function workflowDetailTabFromRoute(route: RouteKey | null): WorkflowDetailTab {
  switch (route) {
    case "workflowDetail":
    case "workflowDetailAutomations": {
      return "automations";
    }
    case "workflowDetailInstructions": {
      return "instructions";
    }
    case "workflowDetailInfo": {
      return "info";
    }
    default: {
      return "automations";
    }
  }
}

function workflowDetailRouteForTab(
  tab: WorkflowDetailTab,
):
  | typeof ROUTES.workflowDetailAutomations
  | typeof ROUTES.workflowDetailInstructions
  | typeof ROUTES.workflowDetailInfo {
  switch (tab) {
    case "automations": {
      return ROUTES.workflowDetailAutomations;
    }
    case "instructions": {
      return ROUTES.workflowDetailInstructions;
    }
    case "info": {
      return ROUTES.workflowDetailInfo;
    }
  }
}

export type WorkflowCronFrequency =
  | "every_day"
  | "every_weekday"
  | "every_week"
  | "every_month"
  | "custom";

export interface WorkflowCronFields {
  readonly frequency: WorkflowCronFrequency;
  readonly hour: number;
  readonly minute: number;
  readonly dayOfWeek: string;
  readonly dayOfMonth: string;
  readonly customCronExpression: string;
}

export function defaultWorkflowCronFields(): WorkflowCronFields {
  return {
    frequency: "every_day",
    hour: 9,
    minute: 0,
    dayOfWeek: "1",
    dayOfMonth: "1",
    customCronExpression: "0 9 * * *",
  };
}

interface WorkflowDetailFileDraft {
  readonly workflowId: string;
  readonly filePath: string | null;
  readonly sourceContent: string;
  readonly content: string;
}

interface WorkflowMetadataPatch {
  readonly workflowId: string;
  readonly displayName?: string;
  readonly name?: string;
  readonly description?: string;
}

/**
 * The workflow uuid for the active detail route, or null elsewhere.
 */
export const currentWorkflowId$ = computed((get): string | null => {
  const route = get(activeRoute$);
  if (!isWorkflowDetailRouteKey(route)) {
    return null;
  }
  const workflowId = get(pathParams$)?.workflowId;
  return typeof workflowId === "string" ? workflowId : null;
});

const internalWorkflowDetailActiveTab$ =
  state<WorkflowDetailTab>("automations");

const internalSelectedFilePath$ = state<string | null>(null);
const internalWorkflowActionDialog$ = state<WorkflowDetailActionDialog>(null);
const internalWorkflowDemoteConfirmOpen$ = state<boolean>(false);
const internalWorkflowCopyForm$ = state<WorkflowCopyFormState>(
  defaultWorkflowCopyForm(),
);
const internalWorkflowFileDraft$ = state<WorkflowDetailFileDraft | null>(null);
const internalEditingWorkflowAutomationId$ = state<string | null>(null);
const internalEditingGoogleCalendarId$ = state("");
const internalWorkflowMetadataPatch$ = state<WorkflowMetadataPatch | null>(
  null,
);
const internalCreateGithubPullRequestAction$ =
  state<GithubPullRequestAction>("closed");
const internalEditingGithubPullRequestAction$ =
  state<GithubPullRequestAction | null>(null);
const internalWorkflowAutomationCreateDialog$ =
  state<WorkflowAutomationCreateDialog>(null);
const internalCreatedWorkflowWebhookAutomation$ =
  state<WorkflowWebhookAutomationSummary | null>(null);
const internalWorkflowAutomationPickerOpen$ = state(false);
type WorkflowWebhookUpgradeDialogSource =
  | { readonly action: "create"; readonly workflowId: string }
  | { readonly action: "enable"; readonly automationId: string }
  | { readonly action: "menu" };
const internalWorkflowWebhookUpgradeDialogSource$ =
  state<WorkflowWebhookUpgradeDialogSource | null>(null);
const internalWorkflowAutomationPickerCategory$ =
  state<WorkflowAutomationCategoryKey>("schedule");
const internalCreateNotionPageContentUpdatedScope$ =
  state<NotionPageContentUpdatedScopeMode>("page");
const internalRevealWebhookSecretAutomationId$ = state<string | null>(null);
const internalCreateGmailMatchConditions$ = state<
  readonly GmailMatchCondition[]
>(defaultGmailMatchConditions());
const internalEditingGmailMatchConditions$ = state<
  Readonly<Record<string, readonly GmailMatchCondition[]>>
>({});
const internalCreateScheduleCronFields$ = state<WorkflowCronFields>(
  defaultWorkflowCronFields(),
);
const internalEditingScheduleCronFields$ = state<WorkflowCronFields>(
  defaultWorkflowCronFields(),
);
export const workflowActionDialog$ = computed((get) => {
  return get(internalWorkflowActionDialog$);
});

export const workflowDemoteConfirmOpen$ = computed((get) => {
  return get(internalWorkflowDemoteConfirmOpen$);
});

export const setWorkflowDemoteConfirmOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalWorkflowDemoteConfirmOpen$, open);
  },
);

export const workflowCopyForm$ = computed((get) => {
  return get(internalWorkflowCopyForm$);
});

const FILTER_PARAM = "filter";
const SORT_MODE_PARAM = "sort";
const AGENT_PARAM = "agent";

/** The sentinel agent-filter value that clears the agent scope. */
export const WORKFLOW_ALL_AGENTS = "all";

function readSearchParam<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = params.get(key) ?? "";
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export const workflowFilter$ = computed((get): WorkflowFilter => {
  return readSearchParam(
    get(searchParams$),
    FILTER_PARAM,
    ["all", "automated", "without", "private", "public"],
    "all",
  );
});

export const workflowSortMode$ = computed((get): WorkflowSortMode => {
  return readSearchParam(
    get(searchParams$),
    SORT_MODE_PARAM,
    ["next-run", "alphabetical", "created"],
    "next-run",
  );
});

/**
 * The agent the list is scoped to, keyed by agent uuid, or `WORKFLOW_ALL_AGENTS`
 * when unscoped. The value is validated against the visible agents in the view,
 * so an unknown id simply yields an empty list.
 */
export const workflowAgentFilter$ = computed((get): string => {
  return get(searchParams$).get(AGENT_PARAM) ?? WORKFLOW_ALL_AGENTS;
});

function nextSearchParams(
  current: URLSearchParams,
  key: string,
  value: string,
  fallback: string,
): URLSearchParams {
  const params = new URLSearchParams(current);
  if (value === fallback) {
    params.delete(key);
  } else {
    params.set(key, value);
  }
  return params;
}

export const setWorkflowFilter$ = command(
  ({ get, set }, value: WorkflowFilter) => {
    set(
      replaceSearchParams$,
      nextSearchParams(get(searchParams$), FILTER_PARAM, value, "all"),
    );
  },
);

export const setWorkflowSortMode$ = command(
  ({ get, set }, value: WorkflowSortMode) => {
    set(
      replaceSearchParams$,
      nextSearchParams(get(searchParams$), SORT_MODE_PARAM, value, "next-run"),
    );
  },
);

export const setWorkflowAgentFilter$ = command(
  ({ get, set }, value: string) => {
    set(
      replaceSearchParams$,
      nextSearchParams(
        get(searchParams$),
        AGENT_PARAM,
        value,
        WORKFLOW_ALL_AGENTS,
      ),
    );
  },
);

export const setWorkflowActionDialog$ = command(
  ({ set }, dialog: WorkflowDetailActionDialog) => {
    if (dialog === "copy") {
      set(internalWorkflowCopyForm$, defaultWorkflowCopyForm());
    }
    set(internalWorkflowActionDialog$, dialog);
  },
);

export const setWorkflowCopyForm$ = command(
  ({ set }, form: WorkflowCopyFormState) => {
    set(internalWorkflowCopyForm$, form);
  },
);

export const workflowFileDraft$ = computed((get) => {
  return get(internalWorkflowFileDraft$);
});

export const setWorkflowFileDraft$ = command(
  ({ set }, draft: WorkflowDetailFileDraft | null) => {
    set(internalWorkflowFileDraft$, draft);
  },
);

export const workflowMetadataPatch$ = computed((get) => {
  return get(internalWorkflowMetadataPatch$);
});

export const patchWorkflowMetadataForm$ = command(
  (
    { set },
    input: {
      readonly workflowId: string;
      readonly patch: Omit<WorkflowMetadataPatch, "workflowId">;
    },
  ) => {
    set(internalWorkflowMetadataPatch$, (patch) => {
      if (!patch || patch.workflowId !== input.workflowId) {
        return { workflowId: input.workflowId, ...input.patch };
      }
      return { ...patch, ...input.patch };
    });
  },
);

export const resetWorkflowMetadataForm$ = command(({ set }) => {
  set(internalWorkflowMetadataPatch$, null);
});

export const resetWorkflowDetailUiState$ = command(({ set }) => {
  set(internalWorkflowDetailActiveTab$, "automations");
  set(internalSelectedFilePath$, null);
  set(internalWorkflowActionDialog$, null);
  set(internalWorkflowCopyForm$, defaultWorkflowCopyForm());
  set(internalWorkflowFileDraft$, null);
  set(internalEditingWorkflowAutomationId$, null);
  set(internalEditingGoogleCalendarId$, "");
  set(internalWorkflowMetadataPatch$, null);
  set(internalWorkflowAutomationCreateDialog$, null);
  set(internalCreatedWorkflowWebhookAutomation$, null);
  set(internalCreateGithubPullRequestAction$, "closed");
  set(internalEditingGithubPullRequestAction$, null);
  set(internalCreateGmailMatchConditions$, defaultGmailMatchConditions());
  set(internalEditingGmailMatchConditions$, {});
  set(internalCreateScheduleCronFields$, defaultWorkflowCronFields());
  set(internalEditingScheduleCronFields$, defaultWorkflowCronFields());
});

export const workflowDetailActiveTab$ = computed((get) => {
  const route = get(activeRoute$);
  if (isWorkflowDetailRouteKey(route)) {
    return workflowDetailTabFromRoute(route);
  }
  return get(internalWorkflowDetailActiveTab$);
});

export const setWorkflowDetailActiveTab$ = command(
  ({ get, set }, tab: WorkflowDetailTab) => {
    set(internalWorkflowDetailActiveTab$, tab);
    const workflowId = get(currentWorkflowId$);
    if (!workflowId) {
      return;
    }
    set(
      replacePathSilently$,
      workflowDetailRouteForTab(tab),
      { workflowId },
      new URLSearchParams(),
    );
  },
);

export const editingWorkflowAutomationId$ = computed((get) => {
  return get(internalEditingWorkflowAutomationId$);
});

export const setEditingWorkflowAutomationId$ = command(
  ({ set }, automationId: string | null) => {
    if (automationId) {
      set(internalEditingGithubPullRequestAction$, null);
      set(internalEditingGmailMatchConditions$, {});
    }
    set(internalEditingWorkflowAutomationId$, automationId);
  },
);

export const editingGoogleCalendarId$ = computed((get) => {
  return get(internalEditingGoogleCalendarId$);
});

export const setEditingGoogleCalendarId$ = command(
  ({ set }, calendarId: string) => {
    set(internalEditingGoogleCalendarId$, calendarId);
  },
);

export const workflowAutomationCreateDialog$ = computed((get) => {
  return get(internalWorkflowAutomationCreateDialog$);
});

export const createdWorkflowWebhookAutomation$ = computed((get) => {
  return get(internalCreatedWorkflowWebhookAutomation$);
});

export const setCreatedWorkflowWebhookAutomation$ = command(
  ({ set }, automation: WorkflowWebhookAutomationSummary | null) => {
    set(internalCreatedWorkflowWebhookAutomation$, automation);
  },
);

export const revealWebhookSecretAutomationId$ = computed((get) => {
  return get(internalRevealWebhookSecretAutomationId$);
});

export const setRevealWebhookSecretAutomationId$ = command(
  ({ set }, automationId: string | null) => {
    set(internalRevealWebhookSecretAutomationId$, automationId);
  },
);

export const setWorkflowAutomationCreateDialog$ = command(
  ({ set }, dialog: WorkflowAutomationCreateDialog) => {
    set(internalWorkflowAutomationCreateDialog$, dialog);
    if (dialog !== "webhook") {
      set(internalCreatedWorkflowWebhookAutomation$, null);
    }
    if (dialog === "scheduled") {
      set(internalCreateScheduleCronFields$, defaultWorkflowCronFields());
    }
    if (dialog === "github-pull-request") {
      set(internalCreateGithubPullRequestAction$, "closed");
    }
    if (dialog === "gmail") {
      set(internalCreateGmailMatchConditions$, defaultGmailMatchConditions());
    }
    if (dialog === "notion-page-content-updated") {
      set(internalCreateNotionPageContentUpdatedScope$, "page");
    }
  },
);

export const workflowAutomationPickerOpen$ = computed((get) => {
  return get(internalWorkflowAutomationPickerOpen$);
});

export const setWorkflowAutomationPickerOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalWorkflowAutomationPickerOpen$, open);
    // Reset to the first category each time the picker opens.
    if (open) {
      set(internalWorkflowAutomationPickerCategory$, "schedule");
    }
  },
);

export const workflowWebhookUpgradeDialogOpen$ = computed((get) => {
  return get(internalWorkflowWebhookUpgradeDialogSource$) !== null;
});

export const workflowWebhookUpgradeDialogSource$ = computed((get) => {
  return get(internalWorkflowWebhookUpgradeDialogSource$);
});

export const setWorkflowWebhookUpgradeDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(
      internalWorkflowWebhookUpgradeDialogSource$,
      open ? { action: "menu" } : null,
    );
  },
);

export const workflowAutomationPickerCategory$ = computed((get) => {
  return get(internalWorkflowAutomationPickerCategory$);
});

export const setWorkflowAutomationPickerCategory$ = command(
  ({ set }, category: WorkflowAutomationCategoryKey) => {
    set(internalWorkflowAutomationPickerCategory$, category);
  },
);

export const createNotionPageContentUpdatedScope$ = computed((get) => {
  return get(internalCreateNotionPageContentUpdatedScope$);
});

export const setCreateNotionPageContentUpdatedScope$ = command(
  ({ set }, scope: NotionPageContentUpdatedScopeMode) => {
    set(internalCreateNotionPageContentUpdatedScope$, scope);
  },
);

export const createGithubPullRequestAction$ = computed((get) => {
  return get(internalCreateGithubPullRequestAction$);
});

export const setCreateGithubPullRequestAction$ = command(
  ({ set }, action: GithubPullRequestAction) => {
    set(internalCreateGithubPullRequestAction$, action);
  },
);

export const editingGithubPullRequestAction$ = computed((get) => {
  return get(internalEditingGithubPullRequestAction$);
});

export const setEditingGithubPullRequestAction$ = command(
  ({ set }, action: GithubPullRequestAction) => {
    set(internalEditingGithubPullRequestAction$, action);
  },
);

export const createGmailMatchConditions$ = computed((get) => {
  return get(internalCreateGmailMatchConditions$);
});

export const setCreateGmailMatchConditions$ = command(
  ({ set }, conditions: readonly GmailMatchCondition[]) => {
    set(internalCreateGmailMatchConditions$, conditions);
  },
);

export const editingGmailMatchConditions$ = computed((get) => {
  return get(internalEditingGmailMatchConditions$);
});

export const setEditingGmailMatchConditions$ = command(
  (
    { set },
    input: {
      readonly automationId: string;
      readonly conditions: readonly GmailMatchCondition[];
    },
  ) => {
    set(internalEditingGmailMatchConditions$, {
      [input.automationId]: input.conditions,
    });
  },
);

export const createScheduleCronFields$ = computed((get) => {
  return get(internalCreateScheduleCronFields$);
});

export const setCreateScheduleCronFields$ = command(
  ({ set }, fields: WorkflowCronFields) => {
    set(internalCreateScheduleCronFields$, fields);
  },
);

export const editingScheduleCronFields$ = computed((get) => {
  return get(internalEditingScheduleCronFields$);
});

export const setEditingScheduleCronFields$ = command(
  ({ set }, fields: WorkflowCronFields) => {
    set(internalEditingScheduleCronFields$, fields);
  },
);

/** The supplementary file selected in the detail viewer, or null. */
export const selectedWorkflowFilePath$ = computed((get) => {
  return (
    get(searchParams$).get(WORKFLOW_DETAIL_FILE_PARAM) ??
    get(internalSelectedFilePath$)
  );
});

export const targetedWorkflowAutomationId$ = computed((get) => {
  return get(searchParams$).get(WORKFLOW_AUTOMATION_TARGET_PARAM);
});

export const scrollTargetedWorkflowAutomationIntoViewRef$ = onRef(
  command((_context, element: HTMLElement, signal: AbortSignal) => {
    signal.throwIfAborted();
    element.scrollIntoView({ block: "center" });
  }),
);

export const setSelectedWorkflowFilePath$ = command(
  ({ get, set }, path: string | null) => {
    set(internalSelectedFilePath$, path);
    set(internalWorkflowDetailActiveTab$, "instructions");
    const workflowId = get(currentWorkflowId$);
    if (!workflowId) {
      return;
    }
    const params = new URLSearchParams();
    if (path) {
      params.set(WORKFLOW_DETAIL_FILE_PARAM, path);
    }
    set(
      replacePathSilently$,
      ROUTES.workflowDetailInstructions,
      { workflowId },
      params,
    );
  },
);

/** Bump to refetch every workflow list and detail. */
export const reloadWorkflows$ = command(({ set }) => {
  set(reloadWorkflowData$);
});

export function isMorningBriefWorkflow(
  workflow: Pick<WorkflowSummary, "official">,
): boolean {
  return (
    workflow.official?.definitionName === MORNING_BRIEF_OFFICIAL_DEFINITION_NAME
  );
}

/** The current agent detail route's visible workflows. */
export const currentAgentVisibleWorkflows$ = computed(
  async (get): Promise<readonly WorkflowSummary[]> => {
    get(workflowReloadVersion$);
    const agentId = get(currentAgentId$);
    if (!agentId) {
      return [];
    }
    const client = get(apiClient$)(workflowsCollectionContract);
    const result = await accept(client.list({ query: { agentId } }), [200]);
    return result.body.filter((workflow) => {
      return !isMorningBriefWorkflow(workflow);
    });
  },
);

export const allVisibleWorkflows$ = computed(
  async (get): Promise<readonly WorkflowSummary[]> => {
    get(workflowReloadVersion$);
    const locale = get(locale$);
    const client = get(apiClient$)(workflowsCollectionContract);
    const result = await accept(client.list({ query: {} }), [200]);
    return result.body
      .filter((workflow) => {
        return !isMorningBriefWorkflow(workflow);
      })
      .sort((a, b) => {
        if (a.visibility !== b.visibility) {
          return a.visibility === "public" ? -1 : 1;
        }
        const aTitle = a.displayName ?? a.name;
        const bTitle = b.displayName ?? b.name;
        return aTitle.localeCompare(bTitle, locale);
      });
  },
);

export const allWorkflowAutomationEntries$ = computed(
  async (get): Promise<readonly WorkflowAutomationEntry[]> => {
    get(workflowReloadVersion$);
    const locale = get(locale$);
    const automationClient = get(apiClient$)(workflowAutomationsContract);
    const automationResult = await accept(
      automationClient.listWorkspace(),
      [200],
    );
    return automationResult.body
      .filter((entry) => {
        return !isMorningBriefWorkflow(entry.workflow);
      })
      .sort((a, b) => {
        if (a.automation.enabled !== b.automation.enabled) {
          return a.automation.enabled ? -1 : 1;
        }
        const aNext = a.automation.nextRunAt ?? "";
        const bNext = b.automation.nextRunAt ?? "";
        if (aNext && bNext && aNext !== bNext) {
          return aNext.localeCompare(bNext);
        }
        if (aNext !== bNext) {
          return aNext ? -1 : 1;
        }
        const aTitle = a.workflow.displayName ?? a.workflow.name;
        const bTitle = b.workflow.displayName ?? b.workflow.name;
        return aTitle.localeCompare(bTitle, locale);
      });
  },
);

interface WorkflowDetailOverride {
  readonly detail: WorkflowDetailResponse | null;
  readonly reloadVersion: number;
  readonly workflowId: string;
}

const currentWorkflowDetailOverride$ = state<WorkflowDetailOverride | null>(
  null,
);

async function readWorkflowDetail(
  createClient: ApiClientFactory,
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowDetailResponse | null> {
  const result = await accept(
    createClient(workflowsDetailContract).get({
      params: { workflowId },
      ...(signal ? { fetchOptions: { signal } } : {}),
    }),
    [200, 404],
    signal,
  );
  return result.status === 404 ? null : result.body;
}

/** The workflow detail derived from the active route. */
export const currentWorkflowDetail$ = computed(
  (get): Promise<WorkflowDetailResponse | null> => {
    const reloadVersion = get(workflowReloadVersion$);
    const workflowId = get(currentWorkflowId$);
    if (!workflowId) {
      return Promise.resolve(null);
    }
    const override = get(currentWorkflowDetailOverride$);
    if (
      override?.workflowId === workflowId &&
      override.reloadVersion === reloadVersion
    ) {
      return Promise.resolve(override.detail);
    }
    return readWorkflowDetail(get(apiClient$), workflowId);
  },
);

/** Refresh the same summary the open page renders, owned by the caller. */
export const reloadCurrentWorkflowDetail$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const workflowId = get(currentWorkflowId$);
    if (!workflowId) {
      return null;
    }
    const reloadVersion = get(workflowReloadVersion$);
    const detail = await readWorkflowDetail(
      get(apiClient$),
      workflowId,
      signal,
    );
    signal.throwIfAborted();
    if (
      get(currentWorkflowId$) === workflowId &&
      get(workflowReloadVersion$) === reloadVersion
    ) {
      // Publish only an authoritative successful read. Failed or cancelled
      // confirmation retains the last resolved workflow detail.
      set(currentWorkflowDetailOverride$, {
        detail,
        reloadVersion,
        workflowId,
      });
    }
    return detail;
  },
);

export const updateWorkflow$ = command(
  async (
    { get, set },
    input: { workflowId: string; body: WorkflowUpdateRequest },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowsDetailContract);
    await accept(
      client.update({
        params: { workflowId: input.workflowId },
        body: input.body,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const deleteWorkflow$ = command(
  async ({ get, set }, workflowId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(workflowsDetailContract);
    await accept(
      client.delete({
        params: { workflowId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const copyWorkflow$ = command(
  async (
    { get, set },
    input: { workflowId: string; toAgentId: string },
    signal: AbortSignal,
  ): Promise<WorkflowSummary> => {
    const client = get(apiClient$)(workflowsDetailContract);
    const result = await accept(
      client.copy({
        params: { workflowId: input.workflowId },
        body: { toAgentId: input.toAgentId },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
    return result.body;
  },
);
export const openWorkflowChat$ = command(
  async ({ get, set }, workflowId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(workflowsDetailContract);
    const result = await accept(
      client.chatThread({
        params: { workflowId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    const draft = set(ensureDraft$, result.body.chatThreadId);
    set(draft.clear$);
    set(draft.setInput$, result.body.prompt);
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId: result.body.chatThreadId },
    });
  },
);

type WorkflowVisibilityAction = "publish" | "demote";

export const changeWorkflowVisibility$ = command(
  async (
    { get, set },
    input: { workflowId: string; action: WorkflowVisibilityAction },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowVisibilityContract);
    const params = { workflowId: input.workflowId };
    const options = { params, fetchOptions: { signal } };
    const request =
      input.action === "publish"
        ? client.publish(options)
        : client.demote(options);
    await accept(request, [200]);
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowScheduleAutomation$ = command(
  async (
    { get, set },
    input: { workflowId: string; schedule: WorkflowSchedule },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: { schedule: input.schedule },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowGmailNewMessageAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: GmailNewMessageEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: input.eventConfig,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowGmailLabelAppliedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: GmailLabelAppliedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-label-applied",
          eventConfig: input.eventConfig,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowGithubWorkflowRunCompletedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: GithubWorkflowRunCompletedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "github-workflow-run-completed",
          eventConfig: input.eventConfig,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

type GithubWebhookAutomationCreateInput =
  | {
      readonly workflowId: string;
      readonly eventType: "github-pull-request";
      readonly eventConfig: GithubPullRequestEventConfig;
    }
  | {
      readonly workflowId: string;
      readonly eventType: "github-workflow-job-completed";
      readonly eventConfig: GithubWorkflowJobCompletedEventConfig;
    }
  | {
      readonly workflowId: string;
      readonly eventType: "github-pull-request-review-submitted";
      readonly eventConfig: GithubPullRequestReviewSubmittedEventConfig;
    }
  | {
      readonly workflowId: string;
      readonly eventType: "github-deployment-status-created";
      readonly eventConfig: GithubDeploymentStatusCreatedEventConfig;
    }
  | {
      readonly workflowId: string;
      readonly eventType: "github-issue-comment-created";
      readonly eventConfig: GithubIssueCommentCreatedEventConfig;
    };

export const createWorkflowGithubWebhookAutomation$ = command(
  async (
    { get, set },
    input: GithubWebhookAutomationCreateInput,
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    const body: WorkflowAutomationCreateRequest =
      input.eventType === "github-pull-request"
        ? {
            kind: "event",
            eventType: input.eventType,
            eventConfig: input.eventConfig,
          }
        : input.eventType === "github-workflow-job-completed"
          ? {
              kind: "event",
              eventType: input.eventType,
              eventConfig: input.eventConfig,
            }
          : input.eventType === "github-pull-request-review-submitted"
            ? {
                kind: "event",
                eventType: input.eventType,
                eventConfig: input.eventConfig,
              }
            : input.eventType === "github-deployment-status-created"
              ? {
                  kind: "event",
                  eventType: input.eventType,
                  eventConfig: input.eventConfig,
                }
              : {
                  kind: "event",
                  eventType: input.eventType,
                  eventConfig: input.eventConfig,
                };
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body,
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowGoogleCalendarEventAutomation$ = command(
  async (
    { get, set },
    input:
      | {
          readonly workflowId: string;
          readonly eventType: "google-calendar-event-created";
          readonly eventConfig: GoogleCalendarEventCreatedEventConfig;
        }
      | {
          readonly workflowId: string;
          readonly eventType: "google-calendar-event-updated";
          readonly eventConfig: GoogleCalendarEventUpdatedEventConfig;
        }
      | {
          readonly workflowId: string;
          readonly eventType: "google-calendar-event-cancelled";
          readonly eventConfig: GoogleCalendarEventCancelledEventConfig;
        },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    const body: WorkflowAutomationCreateRequest =
      input.eventType === "google-calendar-event-created"
        ? {
            kind: "event",
            eventType: "google-calendar-event-created",
            eventConfig: input.eventConfig,
          }
        : input.eventType === "google-calendar-event-updated"
          ? {
              kind: "event",
              eventType: "google-calendar-event-updated",
              eventConfig: input.eventConfig,
            }
          : {
              kind: "event",
              eventType: "google-calendar-event-cancelled",
              eventConfig: input.eventConfig,
            };
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body,
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowGoogleFormsResponseSubmittedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: GoogleFormsResponseSubmittedEventCreateConfig;
    },
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    const client = get(apiClient$)(workflowAutomationsContract);
    const result = await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: input.eventConfig,
        },
        fetchOptions: { signal },
      }),
      [201],
      signal,
    );
    signal.throwIfAborted();
    if (
      result.body.kind !== "event" ||
      result.body.eventType !== "google-forms-response-submitted"
    ) {
      throw new Error("Expected Google Forms workflow automation summary");
    }
    set(reloadWorkflows$);
    return result.body.warning;
  },
);

export const createWorkflowChatRunFinishedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: ChatRunFinishedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: input.eventConfig,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowGoogleMeetTranscriptGeneratedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig?: GoogleMeetTranscriptGeneratedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "google-meet-transcript-generated",
          eventConfig: input.eventConfig ?? {
            provider: "google-meet",
            event: "transcript_generated",
            scope: { type: "organizer_user" },
          },
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowNotionChildPageAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: NotionChildPageCreatedEventCreateConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: input.eventConfig,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowNotionDatabaseItemAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: NotionDatabaseItemCreatedEventCreateConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
          eventConfig: input.eventConfig,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowNotionPageContentUpdatedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: NotionPageContentUpdatedEventCreateConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: input.eventConfig,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowStripeInvoicePaidAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly billingReasons: readonly StripeInvoiceBillingReason[];
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "stripe-invoice-paid",
          eventConfig: {
            provider: "stripe",
            event: "invoice_paid",
            ...(input.billingReasons.length > 0
              ? { billingReasons: [...input.billingReasons] }
              : {}),
          },
        },
        fetchOptions: { signal },
      }),
      [201],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowWebhookAutomation$ = command(
  async (
    { get, set },
    input: { readonly workflowId: string },
    signal: AbortSignal,
  ): Promise<WorkflowWebhookAutomationSummary | null> => {
    const client = get(apiClient$)(workflowAutomationsContract);
    const result = await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "webhook-received",
          eventConfig: {
            provider: "webhook",
            event: "received",
            auth: { mode: "hmac-sha256" },
          },
        },
        fetchOptions: { signal },
      }),
      [201, 402],
    );
    signal.throwIfAborted();
    if (result.status === 402) {
      if (result.body.error.code === "TEAM_REQUIRED") {
        set(internalWorkflowWebhookUpgradeDialogSource$, {
          action: "create",
          workflowId: input.workflowId,
        });
        return null;
      }
      throw new Error(result.body.error.message);
    }
    if (
      result.body.kind !== "event" ||
      result.body.eventType !== "webhook-received"
    ) {
      throw new Error("Expected webhook workflow automation summary");
    }
    return result.body;
  },
);

export const revealWorkflowWebhookSecret$ = command(
  async (
    { get },
    input: { readonly automationId: string },
    signal: AbortSignal,
  ): Promise<WorkflowWebhookSecretResponse> => {
    const client = get(apiClient$)(workflowAutomationsContract);
    const result = await accept(
      client.revealWebhookSecret({
        params: { id: input.automationId },
        body: undefined,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const updateWorkflowAutomationEventConfig$ = command(
  async (
    { get, set },
    input: { readonly automationId: string } & Extract<
      WorkflowAutomationUpdateRequest,
      { readonly eventConfig: unknown }
    >,
    signal: AbortSignal,
  ) => {
    const { automationId, ...body } = input;
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.update({
        params: { id: automationId },
        body,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const updateWorkflowGoogleCalendarAutomationEventConfig$ = command(
  async (
    { get, set },
    input: {
      readonly automationId: string;
      readonly eventConfig: GoogleCalendarAutomationEventConfig;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarWorkflowAutomationSummary> => {
    await set(updateWorkflowAutomationEventConfig$, input, signal);
    const detail = await get(currentWorkflowDetail$);
    signal.throwIfAborted();
    const automation = detail?.automations.find((candidate) => {
      return candidate.id === input.automationId;
    });
    const eventMatches =
      automation?.kind === "event" &&
      ((automation.eventType === "google-calendar-event-created" &&
        input.eventConfig.event === "event_created") ||
        (automation.eventType === "google-calendar-event-updated" &&
          input.eventConfig.event === "event_updated") ||
        (automation.eventType === "google-calendar-event-cancelled" &&
          input.eventConfig.event === "event_cancelled"));
    if (
      !automation ||
      !isGoogleCalendarWorkflowAutomation(automation) ||
      !eventMatches ||
      automation.warning !== undefined
    ) {
      throw new Error("Google Calendar automation recovery did not complete");
    }
    return automation;
  },
);

export const updateWorkflowScheduleAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly automationId: string;
      readonly schedule: WorkflowSchedule;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.update({
        params: { id: input.automationId },
        body: { schedule: input.schedule },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const setWorkflowAutomationEnabled$ = command(
  async (
    { get, set },
    input: { automationId: string; enabled: boolean },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    const request = input.enabled
      ? client.enable({
          params: { id: input.automationId },
          fetchOptions: { signal },
        })
      : client.disable({
          params: { id: input.automationId },
          fetchOptions: { signal },
        });
    const result = await accept(request, [200, 402]);
    signal.throwIfAborted();
    if (result.status === 402) {
      if (result.body.error.code === "TEAM_REQUIRED") {
        set(internalWorkflowWebhookUpgradeDialogSource$, {
          action: "enable",
          automationId: input.automationId,
        });
        return;
      }
      throw new Error(result.body.error.message);
    }
    set(reloadWorkflows$);
  },
);

export const pauseWorkflowAutomations$ = command(
  async (
    { get, set },
    automationIds: readonly string[],
    signal: AbortSignal,
  ): Promise<{ readonly pausedCount: number }> => {
    if (automationIds.length === 0) {
      return { pausedCount: 0 };
    }

    const client = get(apiClient$)(workflowAutomationsContract);
    await Promise.all(
      automationIds.map((automationId) => {
        return accept(
          client.disable({
            params: { id: automationId },
            fetchOptions: { signal },
          }),
          [200],
        );
      }),
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
    return { pausedCount: automationIds.length };
  },
);

export const runWorkflowAutomationNow$ = command(
  async (
    { get },
    automationId: string,
    signal: AbortSignal,
  ): Promise<{ chatThreadId: string; runId: string | null }> => {
    const client = get(apiClient$)(workflowAutomationsContract);
    const result = await accept(
      client.run({
        params: { id: automationId },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const deleteWorkflowAutomation$ = command(
  async ({ get, set }, automationId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.delete({ params: { id: automationId }, fetchOptions: { signal } }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);
