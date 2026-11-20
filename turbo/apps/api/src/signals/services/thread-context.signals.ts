import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { phoneUseDevices, phoneUseGrants } from "@okouai/db/schema/phone-use";
import { createEmailMailboxConnections } from "./email-mailbox-context.service";
import { createEmailThreadContext } from "./email-queued-launch-context.service";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { createWechatThreadContext } from "./wechat-context.service";
import { randomUUID } from "node:crypto";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { computed, type Computed } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";
import { object } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { db$, rawSqlReadDb$ } from "../external/db";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  type ChatThreadContinuation,
  resolveChatThreadContinuation,
} from "./chat-session-continuity.service";
import type { ChatThreadRequestRow } from "./chat-thread-request-facts";
import { createDiscordThreadContext } from "./discord-thread-prompt-context.service";
import {
  executionPackageSourcesSchema,
  executionPackageSourcesSql,
  type ExecutionPackageSources,
} from "./execution-workflow-selection";
import { createRunTemplates } from "./run-templates.service";
import {
  type ConnectedAccounts,
  createConnectedAccountsSignals,
} from "./thread-connected-accounts.signals";
import { createThreadConnectorSources } from "./thread-connector-sources.service";
import {
  createThreadAutomationPayload,
  createThreadAutomationSnapshot,
  type ThreadAutomationTarget,
} from "./thread-automation-context.service";
import { createThreadModelSignals } from "./thread-model.signals";
import { createThreadProjectContext } from "./thread-project-context.service";
import { createIncompletePrompt } from "./thread-run-prompt/incomplete";
import {
  createAgentPhoneThreadContext,
  createFeishuThreadContext,
  createSlackThreadContext,
  createTeamsThreadContext,
  createTelegramThreadContext,
} from "./thread-run-context.service";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import {
  createThreadWorkflowContext,
  type ThreadWorkflowContext,
} from "./thread-workflow-context.signals";

type ThreadModels = ReturnType<typeof createThreadModelSignals>;

/** Read-only facts for one claimed Thread and its eventual picked event. */
export interface ThreadContext extends ThreadWorkflowContext {
  readonly threadConnectorSources$: ReturnType<
    typeof createThreadConnectorSources
  >;
  /** Background source acquisition; consumers join the individual nodes below. */
  readonly inputResources$: Computed<Promise<void>>;
  readonly projectContext$: ReturnType<typeof createThreadProjectContext>;
  readonly incompleteContext$: ReturnType<typeof createIncompletePrompt>;
  readonly phoneUseGrant$: Computed<
    Promise<{ readonly deviceId: string; readonly grantId: string } | null>
  >;
  /** Whether this run resumes the thread's native session, and its binding. */
  readonly threadContinuation$: Computed<
    Promise<ChatThreadContinuation | null>
  >;
  readonly computerUseHostGrant$: Computed<
    Promise<{ readonly hostId: string; readonly displayName: string } | null>
  >;
  readonly slackContext$: ReturnType<typeof createSlackThreadContext>;
  readonly feishuContext$: ReturnType<typeof createFeishuThreadContext>;
  readonly teamsContext$: ReturnType<typeof createTeamsThreadContext>;
  readonly telegramContext$: ReturnType<typeof createTelegramThreadContext>;
  readonly emailContext$: ReturnType<typeof createEmailThreadContext>;
  readonly emailMailboxConnections$: ReturnType<
    typeof createEmailMailboxConnections
  >;
  readonly agentPhoneContext$: ReturnType<typeof createAgentPhoneThreadContext>;
  readonly wechatContext$: ReturnType<typeof createWechatThreadContext>;
  readonly discordContext$: ReturnType<typeof createDiscordThreadContext>;
  readonly automationSnapshot$: ReturnType<
    typeof createThreadAutomationSnapshot
  >;
  readonly automationPayload$: ReturnType<typeof createThreadAutomationPayload>;
  readonly automationTarget$: Computed<Promise<ThreadAutomationTarget | null>>;
  readonly executionPackageSources$: Computed<
    Promise<ExecutionPackageSources | null>
  >;
  /** Event-resolved raw rows, independent of guidance/paid-tool assembly. */
  readonly templateSources$: ReturnType<typeof createRunTemplates>["sources$"];
  readonly templates$: ReturnType<typeof createRunTemplates>["templates$"];
  readonly modelSelection$: ThreadModels["modelSelection$"];
  readonly subscriptionSelection$: ThreadModels["subscriptionSelection$"];
  readonly requestedFramework$: ThreadModels["requestedFramework$"];
  readonly modelRoute$: ThreadModels["modelRoute$"];
  readonly providerFramework$: ThreadModels["providerFramework$"];
  readonly dispatchTiming$: Computed<ApiDispatchTimingCollector>;
  /** Generated once per picked event's claim graph. */
  readonly runIds$: Computed<{
    readonly runId: string;
  }>;
  /** Connector accounts chosen from thread, source and default selections. */
  readonly connectorSelection$: ConnectedAccounts["connectorSelection$"];
  readonly connectorSnapshot$: ConnectedAccounts["connectorSnapshot$"];
  readonly connectorThreadSelections$: ConnectedAccounts["threadSelections$"];
}

export function createThreadContext(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  chatThreadId: string,
): ThreadContext {
  const orgId = bootstrap.orgId;
  const dispatchTiming$ = computed(() => {
    return new ApiDispatchTimingCollector();
  });
  const sourceSettings = createThreadSourceSettings(bootstrap);
  const threadConnectorSources$ = createThreadConnectorSourceContext(
    bootstrap,
    chatThreadId,
  );
  const thread$ = computed(async (get) => {
    return (await get(pickedEvent$))?.thread ?? null;
  });
  const integrations = createThreadIntegrationContexts(
    pickedEvent$,
    bootstrap,
    sourceSettings.featureSwitches$,
    dispatchTiming$,
  );
  const model = createThreadModelContext(
    bootstrap,
    chatThreadId,
    pickedEvent$,
    integrations.automationTarget$,
    dispatchTiming$,
  );
  const discordContext$ = createDiscordThreadContext(
    pickedEvent$,
    orgId,
    dispatchTiming$,
  );
  const workflowContext = createThreadWorkflowContext(
    bootstrap,
    pickedEvent$,
    integrations.automationSnapshot$,
  );
  const templateOrgId$ = createThreadOrgId(orgId);
  const templates = createRunTemplates(
    pickedEvent$,
    templateOrgId$,
    sourceSettings.disabledPaidTools$,
    bootstrap,
  );
  const computerUseHostGrant$ = createThreadHostGrant(bootstrap, thread$);
  const phoneUseGrant$ = createThreadPhoneUseGrant(bootstrap, thread$);
  const runIds$ = createRunIds();
  const threadContinuation$ = createThreadContinuation(
    pickedEvent$,
    model.subscriptionSelection$,
    integrations.automationTarget$,
    runIds$,
  );
  const connectedAccounts = createConnectedAccountsSignals(
    bootstrap,
    pickedEvent$,
    dispatchTiming$,
    threadConnectorSources$,
  );
  const emailMailboxConnections$ = createEmailMailboxConnections(
    pickedEvent$,
    connectedAccounts.selectedStoredConnectorSources$,
    orgId,
  );
  const inputSources = {
    connectorSelection$: connectedAccounts.connectorSelection$,
    templateSources$: templates.sources$,
    computerUseHostGrant$,
    phoneUseGrant$,
    modelRoute$: model.modelRoute$,
    threadContinuation$,
    discordContext$,
    emailMailboxConnections$,
    executionPackageSources$: integrations.executionPackageSources$,
  };
  const resources = createThreadInputResources(
    pickedEvent$,
    sourceSettings.featureSwitches$,
    integrations,
    inputSources,
  );
  return {
    threadConnectorSources$,
    inputResources$: resources.inputResources$,
    projectContext$: resources.projectContext$,
    incompleteContext$: resources.incompleteContext$,
    threadContinuation$,
    computerUseHostGrant$,
    phoneUseGrant$,
    slackContext$: integrations.slackContext$,
    feishuContext$: integrations.feishuContext$,
    teamsContext$: integrations.teamsContext$,
    telegramContext$: integrations.telegramContext$,
    emailContext$: integrations.emailContext$,
    emailMailboxConnections$,
    agentPhoneContext$: integrations.agentPhoneContext$,
    wechatContext$: integrations.wechatContext$,
    discordContext$,
    automationSnapshot$: integrations.automationSnapshot$,
    automationPayload$: integrations.automationPayload$,
    automationTarget$: integrations.automationTarget$,
    executionPackageSources$: integrations.executionPackageSources$,
    officialWorkflowObservation$: workflowContext.officialWorkflowObservation$,
    templateSources$: templates.sources$,
    templates$: templates.templates$,
    modelSelection$: model.modelSelection$,
    subscriptionSelection$: model.subscriptionSelection$,
    requestedFramework$: model.requestedFramework$,
    modelRoute$: model.modelRoute$,
    providerFramework$: model.providerFramework$,
    dispatchTiming$,
    runIds$,
    connectorSelection$: connectedAccounts.connectorSelection$,
    connectorSnapshot$: connectedAccounts.connectorSnapshot$,
    connectorThreadSelections$: connectedAccounts.threadSelections$,
  };
}

/** Bind a request's first Thread observation without waiting for unrelated sources. */
function createThreadConnectorSourceContext(
  bootstrap: AgentRunContextSignals,
  chatThreadId: string,
) {
  const orgId = bootstrap.orgId;
  const identity$ = computed(() => {
    return Promise.resolve({
      chatThreadId,
      userId: bootstrap.userId,
      orgId,
      agentId: bootstrap.agentId,
    });
  });
  const ownConnectorSources$ = createThreadConnectorSources(identity$);
  const threadConnectorSources$ = computed(async (get) => {
    const identity = await get(bootstrap.requestThreadConnectorIdentity$);
    const matches =
      identity?.chatThreadId === chatThreadId &&
      identity.userId === bootstrap.userId &&
      identity.orgId === orgId &&
      identity.agentId === bootstrap.agentId;
    // A matching cached miss or failure remains authoritative. The cold source
    // is selected only for another identity, never to recheck accepted data.
    return await get(
      matches ? bootstrap.requestThreadConnectorSources$ : ownConnectorSources$,
    );
  });
  return threadConnectorSources$;
}

function createThreadModelContext(
  bootstrap: AgentRunContextSignals,
  chatThreadId: string,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationTarget$: Computed<Promise<ThreadAutomationTarget | null>>,
  dispatchTiming$: ThreadContext["dispatchTiming$"],
) {
  const effectiveSelection$ = computed(async (get) => {
    const [event, target] = await Promise.all([
      get(pickedEvent$),
      get(automationTarget$),
    ]);
    if (!event) {
      return null;
    }
    // Official Workflows always route through Auto.
    return target?.workflow.officialDefinitionName
      ? {
          selectedModel: AUTO_SELECTED_MODEL,
          codexServiceTier: null,
          reasoningEffort: null,
        }
      : event.modelSelection;
  });
  const creditsWaived$ = createOfficialWorkflowCreditWaiver(
    pickedEvent$,
    automationTarget$,
  );
  return createThreadModelSignals(
    bootstrap,
    chatThreadId,
    effectiveSelection$,
    creditsWaived$,
    dispatchTiming$,
  );
}

function createThreadInputResources(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  featureSwitches$: AgentRunContextSignals["featureSwitches$"],
  integrations: ReturnType<typeof createThreadIntegrationContexts>,
  context: Pick<
    ThreadContext,
    | "connectorSelection$"
    | "templateSources$"
    | "computerUseHostGrant$"
    | "phoneUseGrant$"
    | "modelRoute$"
    | "threadContinuation$"
    | "discordContext$"
    | "emailMailboxConnections$"
    | "executionPackageSources$"
  >,
) {
  const projectContext$ = createThreadProjectContext(
    pickedEvent$,
    featureSwitches$,
  );
  const incompleteContext$ = createIncompletePrompt(pickedEvent$);
  const emailResources$ = computed(async (get) => {
    await Promise.allSettled([
      get(integrations.emailContext$),
      get(context.emailMailboxConnections$),
    ]);
  });
  const integrationSources: Readonly<
    Record<
      Exclude<PickedThreadInputEvent["contextType"], "automation" | null>,
      Computed<Promise<unknown>>
    >
  > = {
    web: projectContext$,
    agent_run: projectContext$,
    slack: integrations.slackContext$,
    feishu: integrations.feishuContext$,
    teams: integrations.teamsContext$,
    telegram: integrations.telegramContext$,
    email: emailResources$,
    agentphone: integrations.agentPhoneContext$,
    wechat: integrations.wechatContext$,
    discord: context.discordContext$,
  };
  const inputResources$ = computed(async (get) => {
    const event = await get(pickedEvent$);
    // The entry starts this once it owns a pickable head and capacity.
    // Automation reads its package candidates with its target.
    if (!event?.contextType || event.contextType === "automation") {
      return;
    }
    // Declare acquisition at the source owner, independently of Prompt/model
    // consumer traversal. No consumer awaits this aggregate. Cached failures
    // surface at their original joins; all started branches remain owned.
    await Promise.allSettled([
      get(context.connectorSelection$),
      get(context.templateSources$),
      get(context.computerUseHostGrant$),
      get(context.phoneUseGrant$),
      get(incompleteContext$),
      get(integrationSources[event.contextType]),
      get(context.modelRoute$),
      get(context.threadContinuation$),
      get(context.executionPackageSources$),
    ]);
  });
  return { inputResources$, projectContext$, incompleteContext$ };
}

function createThreadSourceSettings(bootstrap: AgentRunContextSignals) {
  const featureSwitches$ = computed((get) => {
    return get(bootstrap.featureSwitches$);
  });
  const disabledPaidTools$ = computed((get) => {
    return get(bootstrap.disabledPaidTools$);
  });
  return { featureSwitches$, disabledPaidTools$ };
}

function createThreadIntegrationContexts(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  bootstrap: AgentRunContextSignals,
  featureSwitches$: AgentRunContextSignals["featureSwitches$"],
  dispatchTiming$: ThreadContext["dispatchTiming$"],
) {
  const orgId = bootstrap.orgId;
  const slackContext$ = createSlackThreadContext(pickedEvent$, orgId);
  const feishuContext$ = createFeishuThreadContext(
    pickedEvent$,
    orgId,
    featureSwitches$,
  );
  const teamsContext$ = createTeamsThreadContext(pickedEvent$, orgId);
  const telegramContext$ = createTelegramThreadContext(pickedEvent$, orgId);
  const emailContext$ = createEmailThreadContext(pickedEvent$, orgId);
  const agentPhoneContext$ = createAgentPhoneThreadContext(pickedEvent$, orgId);
  const wechatContext$ = createWechatThreadContext(
    pickedEvent$,
    orgId,
    featureSwitches$,
  );
  const automationSnapshot$ = createThreadAutomationSnapshot(
    pickedEvent$,
    bootstrap,
    dispatchTiming$,
  );
  const automationPayload$ = createThreadAutomationPayload(automationSnapshot$);
  const automationTarget$ = computed(async (get) => {
    return (await get(automationSnapshot$))?.target ?? null;
  });
  const executionPackageSources$ = createThreadExecutionPackageSources(
    bootstrap,
    pickedEvent$,
    automationTarget$,
    dispatchTiming$,
  );
  return {
    slackContext$,
    feishuContext$,
    teamsContext$,
    telegramContext$,
    emailContext$,
    agentPhoneContext$,
    wechatContext$,
    automationSnapshot$,
    automationPayload$,
    automationTarget$,
    executionPackageSources$,
  };
}

/** Routing candidate only; exact accepted artifacts and installation ownership
 * are still validated before a Run can be committed. */
function createOfficialWorkflowCreditWaiver(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationTarget$: ThreadContext["automationTarget$"],
) {
  return computed(async (get) => {
    const [event, target] = await Promise.all([
      get(pickedEvent$),
      get(automationTarget$),
    ]);
    return (
      event?.eventType === "input.automation" &&
      event.contextType === "automation" &&
      target !== null &&
      target.workflow.officialDefinitionName !== null &&
      target.automation.officialBlueprintKey !== null
    );
  });
}

const packageSourcesRowSchema = object({
  packages: executionPackageSourcesSchema,
});

function createThreadExecutionPackageSources(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationTarget$: Computed<Promise<ThreadAutomationTarget | null>>,
  dispatchTiming$: ThreadContext["dispatchTiming$"],
) {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (!event?.contextType) {
      return null;
    }
    if (event.contextType === "automation") {
      const target = await get(automationTarget$);
      return target?.packageSources ?? null;
    }
    const db = get(rawSqlReadDb$);
    const rows = await get(dispatchTiming$).measure(
      "api_dispatch_prepare_execution_package_sources",
      "nested",
      () => {
        return db.execute(
          sql`SELECT ${executionPackageSourcesSql(bootstrap)} AS packages`,
        );
      },
    );
    const [row] = parseRawRows(packageSourcesRowSchema, rows);
    return row?.packages ?? null;
  });
}

function createThreadHostGrant(
  selected: AgentRunContextSignals,
  thread$: Computed<Promise<ChatThreadRequestRow | null>>,
) {
  return computed(async (get) => {
    const thread = await get(thread$);
    if (!thread?.computerUseHostId || thread.userId !== selected.userId) {
      return null;
    }
    const [host] = await get(db$)
      .select({
        hostId: computerUseHosts.id,
        displayName: computerUseHosts.displayName,
      })
      .from(computerUseHosts)
      .where(
        and(
          eq(computerUseHosts.id, thread.computerUseHostId),
          eq(computerUseHosts.orgId, selected.orgId),
          eq(computerUseHosts.userId, selected.userId),
          isNull(computerUseHosts.revokedAt),
        ),
      )
      .limit(1);
    return host ?? null;
  });
}

function createRunIds() {
  return computed(() => {
    return { runId: randomUUID() };
  });
}

function createThreadContinuation(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  selection$: ThreadModels["subscriptionSelection$"],
  automationTarget$: ThreadContext["automationTarget$"],
  runIds$: ThreadContext["runIds$"],
) {
  return computed(async (get): Promise<ChatThreadContinuation | null> => {
    const [event, selection] = await Promise.all([
      get(pickedEvent$),
      get(selection$),
    ]);
    if (!event) {
      throw new Error(
        "Chat thread not found while resolving native continuation",
      );
    }
    // A rejected model selection never reaches native continuation.
    if ("status" in selection) {
      return null;
    }
    const target =
      event.contextType === "automation" ? await get(automationTarget$) : null;
    const identity = get(runIds$);
    return resolveChatThreadContinuation(event.thread, {
      cliAgentType: selection.cliAgentType,
      officialWorkflow: Boolean(target?.workflow.officialDefinitionName),
      admission: {
        ...identity,
        finalizingSourceRunId: event.thread.frameworkSessionRunId,
      },
    });
  });
}

function createThreadPhoneUseGrant(
  bootstrap: AgentRunContextSignals,
  thread$: Computed<Promise<ChatThreadRequestRow | null>>,
) {
  return computed(async (get) => {
    const features = await get(bootstrap.featureSwitches$);
    if (!isFeatureEnabled(FeatureSwitchKey.PhoneUse, features)) {
      return null;
    }
    const thread = await get(thread$);
    if (!thread || thread.userId !== bootstrap.userId) {
      return null;
    }
    const [grant] = await get(db$)
      .select({ deviceId: phoneUseDevices.id, grantId: phoneUseGrants.id })
      .from(phoneUseGrants)
      .innerJoin(
        phoneUseDevices,
        eq(phoneUseDevices.id, phoneUseGrants.deviceId),
      )
      .where(
        and(
          eq(phoneUseGrants.threadId, thread.id),
          eq(phoneUseGrants.orgId, bootstrap.orgId),
          eq(phoneUseGrants.userId, bootstrap.userId),
          eq(phoneUseDevices.orgId, bootstrap.orgId),
          eq(phoneUseDevices.userId, bootstrap.userId),
          eq(phoneUseDevices.generation, phoneUseGrants.deviceGeneration),
        ),
      )
      .limit(1);
    return grant ?? null;
  });
}

function createThreadOrgId(orgId: string) {
  return computed(() => {
    return Promise.resolve(orgId);
  });
}
