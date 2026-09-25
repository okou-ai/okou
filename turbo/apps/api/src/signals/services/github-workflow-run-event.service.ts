import { command } from "ccstate";
import { and, asc, eq } from "drizzle-orm";
import {
  githubWorkflowRunCompletedEventConfigSchema,
  type GithubWorkflowRunCompletedEventConfig,
  type GithubWorkflowRunConclusion,
} from "@okouai/api-contracts/contracts/workflows";
import { githubInstallations } from "@okouai/db/schema/github-installation";
import {
  workflowUserAutomationThreads,
  workflowAutomations,
  workflowGithubProcessedEvents,
  workflows,
} from "@okouai/db/schema/workflow";
import { resolveImmutableDedupeInsert } from "../../lib/immutable-dedupe-insert";
import { logger } from "../../lib/log";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { workflowAutomationCanFire } from "./workflow-automation-access.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import type { AutomationRow } from "./workflow-automation-launch.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import { ensureWorkflowUserAutomationThread } from "./workflow-user-automation-thread.service";
import {
  AutomationEventSourceTiming,
  type AutomationEventRunTiming,
} from "./automation-event-source-timing.service";

const log = logger("api:github-workflow-run-event");

interface GithubUser {
  readonly id: number;
  readonly login: string;
  readonly type: string;
}

interface GithubPullRequestRef {
  readonly number: number;
}

export interface GithubWorkflowRunEventPayload {
  readonly action: string;
  readonly workflow_run: {
    readonly id: number;
    readonly workflow_id: number;
    readonly name: string | null;
    readonly path: string;
    readonly run_number: number;
    readonly run_attempt: number;
    readonly status: string;
    readonly conclusion: GithubWorkflowRunConclusion | null;
    readonly head_branch: string | null;
    readonly head_sha: string;
    readonly event: string;
    readonly html_url: string;
    readonly actor: GithubUser | null;
    readonly triggering_actor: GithubUser | null;
    readonly pull_requests: readonly GithubPullRequestRef[];
  };
  readonly repository: {
    readonly id: number;
    readonly full_name: string;
  };
  readonly installation: {
    readonly id: number;
  };
  readonly sender: GithubUser;
}

type GithubInstallationRecord = typeof githubInstallations.$inferSelect;

interface GithubWorkflowRunAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly config: GithubWorkflowRunCompletedEventConfig;
}

export async function prepareGithubWorkflowRunEventConfigForPersist(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly eventConfig: GithubWorkflowRunCompletedEventConfig;
  },
): Promise<
  | {
      readonly kind: "ok";
      readonly eventConfig: GithubWorkflowRunCompletedEventConfig;
    }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  const [installation] = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, args.orgId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);
  if (!installation) {
    return {
      kind: "bad-request",
      message: "Install GitHub before creating GitHub workflow run automations",
    };
  }
  return {
    kind: "ok",
    eventConfig: githubWorkflowRunCompletedEventConfigSchema.parse(
      args.eventConfig,
    ),
  };
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function matchesNormalizedFilter(
  values: readonly string[] | undefined,
  actualValues: readonly string[],
): boolean {
  if (!values) {
    return true;
  }
  const normalizedActual = new Set(actualValues.map(normalized));
  return values.some((value) => {
    return normalizedActual.has(normalized(value));
  });
}

function workflowRunMatchesConfig(args: {
  readonly config: GithubWorkflowRunCompletedEventConfig;
  readonly payload: GithubWorkflowRunEventPayload;
}): boolean {
  const { filters } = args.config;
  const run = args.payload.workflow_run;
  const conclusion = run.conclusion;
  return (
    conclusion !== null &&
    matchesNormalizedFilter(filters.repositories, [
      args.payload.repository.full_name,
      String(args.payload.repository.id),
    ]) &&
    matchesNormalizedFilter(filters.workflows, [
      String(run.workflow_id),
      ...(run.name === null ? [] : [run.name]),
      run.path,
    ]) &&
    (!filters.conclusions || filters.conclusions.includes(conclusion)) &&
    (!filters.branches ||
      (run.head_branch !== null &&
        filters.branches.includes(run.head_branch))) &&
    (!filters.events || filters.events.includes(run.event)) &&
    matchesNormalizedFilter(
      filters.actors,
      run.actor ? [run.actor.login, String(run.actor.id)] : [],
    )
  );
}

async function findActiveInstallation(args: {
  readonly db: ReadonlyDb;
  readonly ghInstallationId: string;
}): Promise<GithubInstallationRecord | null> {
  const [installation] = await args.db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installationId, args.ghInstallationId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);
  return installation ?? null;
}

async function loadGithubWorkflowRunAutomations(
  args: {
    readonly db: Db;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<readonly GithubWorkflowRunAutomationRow[]> {
  const rows = await args.db
    .select({
      automation: workflowAutomationColumns(),
      agentId: workflows.agentId,
      workflowName: workflows.name,
      workflowDisplayName: workflows.displayName,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
    })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, workflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          workflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          workflowAutomations.workflowId,
        ),
      ),
    )
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventType, "github-workflow-run-completed"),
      ),
    )
    .orderBy(asc(workflowAutomations.createdAt));
  signal.throwIfAborted();

  const automations: GithubWorkflowRunAutomationRow[] = [];
  const currentTime = nowDate();
  for (const row of rows) {
    const config = githubWorkflowRunCompletedEventConfigSchema.safeParse(
      row.automation.eventConfig,
    );
    if (!config.success) {
      continue;
    }
    const canFire = await workflowAutomationCanFire(
      args.db,
      {
        automation: row.automation,
        agentId: row.agentId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!canFire) {
      continue;
    }
    const chatThreadId =
      row.chatThreadId ??
      (await args.db.transaction(async (tx) => {
        return await ensureWorkflowUserAutomationThread(tx, {
          orgId: row.automation.orgId,
          userId: row.automation.ownerUserId,
          workflowId: row.automation.workflowId,
          agentId: row.agentId,
          workflowTitle: row.workflowDisplayName ?? row.workflowName,
          currentTime,
        });
      }));
    signal.throwIfAborted();
    automations.push({
      automation: row.automation,
      agentId: row.agentId,
      workflowName: row.workflowName,
      chatThreadId,
      config: config.data,
    });
  }
  return automations;
}

async function recordProcessedDelivery(args: {
  readonly db: Db;
  readonly automation: GithubWorkflowRunAutomationRow;
  readonly deliveryId: string;
  readonly payload: GithubWorkflowRunEventPayload;
}): Promise<string | null> {
  const row = resolveImmutableDedupeInsert(
    await settle(
      args.db
        .insert(workflowGithubProcessedEvents)
        .values({
          automationId: args.automation.automation.id,
          githubDeliveryId: args.deliveryId,
          repo: args.payload.repository.full_name,
          subjectType: null,
          subjectNumber: null,
          action: args.payload.action,
          labelNameNormalized: null,
          createdAt: nowDate(),
        })
        .returning({ id: workflowGithubProcessedEvents.id }),
    ),
  );
  return row?.id ?? null;
}

function githubWorkflowRunTriggerContext(args: {
  readonly automation: GithubWorkflowRunAutomationRow;
  readonly deliveryId: string;
  readonly payload: GithubWorkflowRunEventPayload;
}): WorkflowAutomationContext {
  const run = args.payload.workflow_run;
  const workflowName = run.name ?? run.path;
  return {
    workflowName: args.automation.workflowName,
    eventType: "github-workflow-run-completed",
    trigger: `GitHub Actions workflow "${workflowName}" completed with conclusion "${run.conclusion}" (run ${run.id} attempt ${run.run_attempt}, GitHub webhook delivery ${args.deliveryId}).`,
    notes: [
      "Not included below: jobs, logs, artifacts, and pull request details. Connected GitHub tools and the GitHub API return them.",
    ],
    event: {
      automationId: args.automation.automation.id,
      deliveryId: args.deliveryId,
      event: "workflow_run",
      action: args.payload.action,
      repository: {
        id: args.payload.repository.id,
        fullName: args.payload.repository.full_name,
      },
      workflow: {
        id: run.workflow_id,
        name: run.name,
        path: run.path,
      },
      run: {
        id: run.id,
        number: run.run_number,
        attempt: run.run_attempt,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
      },
      branch: run.head_branch,
      commitSha: run.head_sha,
      triggeringEvent: run.event,
      actor: run.actor,
      triggeringActor: run.triggering_actor,
      pullRequests: run.pull_requests.map((pullRequest) => {
        return { number: pullRequest.number };
      }),
    },
  };
}

const startGithubWorkflowRunAutomation$ = command(
  async (
    { set },
    args: {
      readonly automation: GithubWorkflowRunAutomationRow;
      readonly deliveryId: string;
      readonly payload: GithubWorkflowRunEventPayload;
      readonly apiStartTime: number;
      readonly timing: AutomationEventRunTiming;
    },
    signal: AbortSignal,
  ): Promise<"ok" | "error"> => {
    const context = githubWorkflowRunTriggerContext(args);
    const result = await set(
      runWorkflowAutomationNow$,
      {
        due: {
          automation: args.automation.automation,
          agentId: args.automation.agentId,
          chatThreadId: args.automation.chatThreadId,
        },
        automationContext: context,
        apiStartTime: args.apiStartTime,
        triggerSource: "automation-event",
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        timing: args.timing.collectorForRunStart(),
      },
      signal,
    );
    signal.throwIfAborted();
    return result.kind === "ok" || result.kind === "enqueued" ? "ok" : "error";
  },
);

export const dispatchGithubWorkflowRunAutomations$ = command(
  async (
    { set },
    args: {
      readonly deliveryId: string;
      readonly payload: GithubWorkflowRunEventPayload;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt?: number;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly kind: "ok";
    readonly dispatched: number;
    readonly duplicates: number;
  }> => {
    if (
      args.payload.action !== "completed" ||
      args.payload.workflow_run.conclusion === null
    ) {
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    const sourceTiming = new AutomationEventSourceTiming(
      "github",
      args.apiStartTime,
    );
    if (args.backgroundScheduledAt !== undefined) {
      sourceTiming.recordElapsed(
        "api_dispatch_pre_create_agent_automation_event_background_start_gap",
        args.backgroundScheduledAt,
      );
    }

    const db = set(writeDb$);
    const installation = await sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_source_state",
      async () => {
        return await findActiveInstallation({
          db,
          ghInstallationId: String(args.payload.installation.id),
        });
      },
    );
    signal.throwIfAborted();
    if (!installation) {
      log.debug("Ignoring GitHub workflow run for unbound installation", {
        installationId: String(args.payload.installation.id),
        repository: args.payload.repository.full_name,
        workflowRunId: args.payload.workflow_run.id,
      });
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    const automations = await sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_automations",
      async () => {
        return await loadGithubWorkflowRunAutomations(
          {
            db,
            orgId: installation.orgId,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();

    let dispatched = 0;
    let duplicates = 0;
    for (const automation of automations) {
      const runTiming = sourceTiming.createRunTiming();
      const matches = await runTiming.measure(
        "api_dispatch_pre_create_agent_automation_event_match_automations",
        () => {
          return workflowRunMatchesConfig({
            config: automation.config,
            payload: args.payload,
          });
        },
      );
      signal.throwIfAborted();
      if (!matches) {
        continue;
      }
      const processedId = await runTiming.measure(
        "api_dispatch_pre_create_agent_automation_event_record_processed_event",
        async () => {
          return await recordProcessedDelivery({
            db,
            automation,
            deliveryId: args.deliveryId,
            payload: args.payload,
          });
        },
      );
      signal.throwIfAborted();
      if (!processedId) {
        duplicates += 1;
        continue;
      }

      const result = await set(
        startGithubWorkflowRunAutomation$,
        {
          automation,
          deliveryId: args.deliveryId,
          payload: args.payload,
          apiStartTime: args.apiStartTime,
          timing: runTiming,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result === "ok") {
        dispatched += 1;
        continue;
      }
      await db
        .delete(workflowGithubProcessedEvents)
        .where(eq(workflowGithubProcessedEvents.id, processedId));
      signal.throwIfAborted();
      log.warn("Failed to start GitHub workflow run automation", {
        automationId: automation.automation.id,
        deliveryId: args.deliveryId,
        workflowRunId: args.payload.workflow_run.id,
      });
    }

    return { kind: "ok", dispatched, duplicates };
  },
);
