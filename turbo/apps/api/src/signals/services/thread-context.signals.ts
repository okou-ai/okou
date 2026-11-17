import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { phoneUseDevices, phoneUseGrants } from "@okouai/db/schema/phone-use";
import { createEmailMailboxConnections } from "./email-mailbox-context.service";
import { createEmailThreadContext } from "./email-queued-launch-context.service";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { createWechatThreadContext } from "./wechat-context.service";
import { randomUUID } from "node:crypto";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { computed, type Computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { db$ } from "../external/db";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  type ChatThreadContinuation,
  resolveChatThreadContinuation,
} from "./chat-session-continuity.service";
import type { ChatThreadRequestRow } from "./chat-thread-request-facts";
import { createDiscordThreadContext } from "./discord-thread-prompt-context.service";
import { createRunTemplates } from "./run-templates.service";
import {
  type ConnectedAccounts,
  createConnectedAccountsSignals,
} from "./thread-connected-accounts.signals";
import { createThreadAutomationContext } from "./thread-automation-context.service";
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

export interface ThreadAutomationTarget {
  readonly automation: typeof workflowAutomations.$inferSelect;
  readonly agentId: string;
  readonly workflow: Pick<
    typeof workflows.$inferSelect,
    | "id"
    | "orgId"
    | "agentId"
    | "name"
    | "ownerUserId"
    | "visibility"
    | "officialDefinitionName"
    | "officialInstallationState"
  >;
}

type ThreadModels = ReturnType<typeof createThreadModelSignals>;

/** Read-only facts for one picked event, shared by admission and prompting. */
export interface ThreadContext extends ThreadWorkflowContext {
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
  readonly automationContext$: ReturnType<typeof createThreadAutomationContext>;
  readonly automationTarget$: Computed<Promise<ThreadAutomationTarget | null>>;
  readonly templates$: ReturnType<typeof createRunTemplates>;
  readonly queuedModel$: ThreadModels["queuedModel$"];
  readonly modelSelection$: ThreadModels["modelSelection$"];
  readonly subscriptionSelection$: ThreadModels["subscriptionSelection$"];
  readonly requestedFramework$: ThreadModels["requestedFramework$"];
  readonly modelRoute$: ThreadModels["modelRoute$"];
  readonly providerFramework$: ThreadModels["providerFramework$"];
  readonly dispatchTiming$: ThreadModels["dispatchTiming$"];
  /** Generated once per picked event's claim graph. */
  readonly runIds$: Computed<{
    readonly runId: string;
  }>;
  /** Connector accounts chosen from thread, source and default selections. */
  readonly connectorSelection$: ConnectedAccounts["connectorSelection$"];
  readonly connectorSnapshot$: ConnectedAccounts["connectorSnapshot$"];
  readonly connectorThreadSelections$: ConnectedAccounts["threadSelections$"];
  readonly selectedConnectorSources$: ConnectedAccounts["selectedStoredConnectorSources$"];
}

export function createThreadContext(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
): ThreadContext {
  const orgId = bootstrap.orgId;
  const sourceSettings = createThreadSourceSettings(bootstrap);
  const thread$ = computed(async (get) => {
    return (await get(pickedEvent$))?.thread ?? null;
  });
  const integrations = createThreadIntegrationContexts(
    pickedEvent$,
    orgId,
    sourceSettings.featureSwitches$,
  );
  const modelInput$ = createThreadModelInput(
    pickedEvent$,
    integrations.automationTarget$,
  );
  const creditsWaived$ = createOfficialWorkflowCreditWaiver(
    pickedEvent$,
    integrations.automationTarget$,
  );
  const model = createThreadModelSignals(
    bootstrap,
    modelInput$,
    creditsWaived$,
  );
  const discordContext$ = createDiscordThreadContext(
    pickedEvent$,
    orgId,
    model.dispatchTiming$,
  );
  const workflowContext = createThreadWorkflowContext(
    bootstrap,
    pickedEvent$,
    integrations.automationContext$,
    integrations.automationTarget$,
  );
  const templateOrgId$ = createThreadOrgId(orgId);
  const templates$ = createRunTemplates(
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
  const connectorSourceId$ = createConnectorSourceId(
    pickedEvent$,
    integrations.automationContext$,
    integrations.feishuContext$,
  );
  const connectedAccounts = createConnectedAccountsSignals(
    bootstrap,
    pickedEvent$,
    connectorSourceId$,
    model.dispatchTiming$,
  );
  const emailMailboxConnections$ = createEmailMailboxConnections(
    pickedEvent$,
    connectedAccounts.selectedStoredConnectorSources$,
    orgId,
  );
  const inputSources = {
    connectorSelection$: connectedAccounts.connectorSelection$,
    templates$,
    computerUseHostGrant$,
    phoneUseGrant$,
    modelRoute$: model.modelRoute$,
    threadContinuation$,
    discordContext$,
    emailMailboxConnections$,
  };
  const resources = createThreadInputResources(
    pickedEvent$,
    sourceSettings.featureSwitches$,
    integrations,
    inputSources,
  );
  return {
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
    automationContext$: integrations.automationContext$,
    automationTarget$: integrations.automationTarget$,
    workflows$: workflowContext.workflows$,
    officialWorkflows$: workflowContext.officialWorkflows$,
    officialWorkflowObservation$: workflowContext.officialWorkflowObservation$,
    templates$,
    queuedModel$: model.queuedModel$,
    modelSelection$: model.modelSelection$,
    subscriptionSelection$: model.subscriptionSelection$,
    requestedFramework$: model.requestedFramework$,
    modelRoute$: model.modelRoute$,
    providerFramework$: model.providerFramework$,
    dispatchTiming$: model.dispatchTiming$,
    runIds$,
    connectorSelection$: connectedAccounts.connectorSelection$,
    connectorSnapshot$: connectedAccounts.connectorSnapshot$,
    connectorThreadSelections$: connectedAccounts.threadSelections$,
    selectedConnectorSources$:
      connectedAccounts.selectedStoredConnectorSources$,
  };
}

function createThreadInputResources(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  featureSwitches$: AgentRunContextSignals["featureSwitches$"],
  integrations: ReturnType<typeof createThreadIntegrationContexts>,
  context: Pick<
    ThreadContext,
    | "connectorSelection$"
    | "templates$"
    | "computerUseHostGrant$"
    | "phoneUseGrant$"
    | "modelRoute$"
    | "threadContinuation$"
    | "discordContext$"
    | "emailMailboxConnections$"
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
      NonNullable<PickedThreadInputEvent["contextType"]>,
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
    automation: integrations.automationContext$,
  };
  const inputResources$ = computed(async (get) => {
    const event = await get(pickedEvent$);
    // The entry starts this only after it owns a pickable head and capacity.
    // Automation retains its target/budget admission before resource reads.
    if (!event?.contextType || event.contextType === "automation") {
      return;
    }
    // Declare acquisition at the source owner, independently of Prompt/model
    // consumer traversal. No consumer awaits this aggregate. Cached failures
    // surface at their original joins; all started branches remain owned.
    await Promise.allSettled([
      get(context.connectorSelection$),
      get(context.templates$),
      get(context.computerUseHostGrant$),
      get(context.phoneUseGrant$),
      get(incompleteContext$),
      get(integrationSources[event.contextType]),
      get(context.modelRoute$),
      get(context.threadContinuation$),
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
  orgId: string,
  featureSwitches$: AgentRunContextSignals["featureSwitches$"],
) {
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
  const automationContext$ = createThreadAutomationContext(pickedEvent$);
  const automationTarget$ = createAutomationTarget(automationContext$);
  return {
    slackContext$,
    feishuContext$,
    teamsContext$,
    telegramContext$,
    emailContext$,
    agentPhoneContext$,
    wechatContext$,
    automationContext$,
    automationTarget$,
  };
}

function createThreadModelInput(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationTarget$: ThreadContext["automationTarget$"],
) {
  return computed(async (get) => {
    const [event, target] = await Promise.all([
      get(pickedEvent$),
      get(automationTarget$),
    ]);
    // Platform policy wins over an input captured before this policy shipped.
    return event && target?.workflow.officialDefinitionName
      ? {
          ...event,
          canonicalModelSelection: {
            selectedModel: AUTO_SELECTED_MODEL,
            codexServiceTier: null,
            reasoningEffort: null,
          },
        }
      : event;
  });
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

function createAutomationTarget(
  automationContext$: ReturnType<typeof createThreadAutomationContext>,
) {
  return computed(async (get): Promise<ThreadAutomationTarget | null> => {
    const event = await get(automationContext$);
    if (!event) {
      return null;
    }
    const [row] = await get(db$)
      .select({
        automation: workflowAutomationColumns(),
        agentId: workflows.agentId,
        workflow: {
          id: workflows.id,
          orgId: workflows.orgId,
          agentId: workflows.agentId,
          name: workflows.name,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
          officialDefinitionName: workflows.officialDefinitionName,
          officialInstallationState: workflows.officialInstallationState,
        },
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .where(eq(workflowAutomations.id, event.automationId))
      .limit(1);
    return row ?? null;
  });
}

function createConnectorSourceId(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationContext$: ThreadContext["automationContext$"],
  feishuContext$: ThreadContext["feishuContext$"],
) {
  return computed(async (get): Promise<string | undefined> => {
    const event = await get(pickedEvent$);
    // Only these inputs carry the integration account that delivered them.
    switch (event?.contextType) {
      case "automation": {
        return (await get(automationContext$))?.connectorSourceId ?? undefined;
      }
      case "feishu": {
        return (await get(feishuContext$))?.connectorSourceId;
      }
      default: {
        return undefined;
      }
    }
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
