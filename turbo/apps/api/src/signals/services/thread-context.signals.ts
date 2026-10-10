import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { computed, type Computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { db$ } from "../external/db";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  chatThreadSessionIdentity,
  createChatThreadSessionRead,
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
  readonly sessionRead$: ReturnType<typeof createChatThreadSessionRead>;
  readonly session$: Computed<
    Promise<ReturnType<typeof chatThreadSessionIdentity>>
  >;
  readonly computerUseHostGrant$: Computed<
    Promise<{ readonly hostId: string; readonly displayName: string } | null>
  >;
  readonly slackContext$: ReturnType<typeof createSlackThreadContext>;
  readonly feishuContext$: ReturnType<typeof createFeishuThreadContext>;
  readonly teamsContext$: ReturnType<typeof createTeamsThreadContext>;
  readonly telegramContext$: ReturnType<typeof createTelegramThreadContext>;
  readonly agentPhoneContext$: ReturnType<typeof createAgentPhoneThreadContext>;
  readonly discordContext$: ReturnType<typeof createDiscordThreadContext>;
  readonly automationContext$: ReturnType<typeof createThreadAutomationContext>;
  readonly automationTarget$: Computed<Promise<ThreadAutomationTarget | null>>;
  readonly templates$: ReturnType<typeof createRunTemplates>;
  readonly queuedModel$: ThreadModels["queuedModel$"];
  readonly subscriptionSelection$: ThreadModels["subscriptionSelection$"];
  readonly requestedFramework$: ThreadModels["requestedFramework$"];
  readonly modelRoute$: ThreadModels["modelRoute$"];
  readonly providerFramework$: ThreadModels["providerFramework$"];
  readonly dispatchTiming$: ThreadModels["dispatchTiming$"];
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
  const userId = bootstrap.userId;
  const sourceFeatureSwitches$ = computed((get) => {
    return get(bootstrap.featureSwitches$);
  });
  const thread$ = computed(async (get) => {
    return (await get(pickedEvent$))?.thread ?? null;
  });
  const sessionRead$ = createChatThreadSessionRead(thread$, orgId, userId);
  const session$ = computed(async (get) => {
    return chatThreadSessionIdentity(await get(sessionRead$));
  });
  const slackContext$ = createSlackThreadContext(pickedEvent$, orgId);
  const feishuContext$ = createFeishuThreadContext(
    pickedEvent$,
    orgId,
    sourceFeatureSwitches$,
  );
  const teamsContext$ = createTeamsThreadContext(pickedEvent$, orgId);
  const telegramContext$ = createTelegramThreadContext(pickedEvent$, orgId);
  const agentPhoneContext$ = createAgentPhoneThreadContext(pickedEvent$, orgId);
  const discordContext$ = createDiscordThreadContext(pickedEvent$, orgId);
  const automationContext$ = createThreadAutomationContext(pickedEvent$);
  const automationTarget$ = createAutomationTarget(automationContext$);
  const workflowContext = createThreadWorkflowContext(
    bootstrap,
    pickedEvent$,
    automationContext$,
    automationTarget$,
  );
  const templates$ = createRunTemplates(
    pickedEvent$,
    orgId,
    sourceFeatureSwitches$,
  );
  const computerUseHostGrant$ = createThreadHostGrant(bootstrap, thread$);
  const model = createThreadModelSignals(bootstrap, pickedEvent$);
  const connectorSourceId$ = createConnectorSourceId(
    pickedEvent$,
    automationContext$,
    feishuContext$,
  );
  const connectedAccounts = createConnectedAccountsSignals(
    bootstrap,
    pickedEvent$,
    connectorSourceId$,
    model.dispatchTiming$,
  );
  return {
    sessionRead$,
    session$,
    computerUseHostGrant$,
    slackContext$,
    feishuContext$,
    teamsContext$,
    telegramContext$,
    agentPhoneContext$,
    discordContext$,
    automationContext$,
    automationTarget$,
    workflows$: workflowContext.workflows$,
    officialWorkflows$: workflowContext.officialWorkflows$,
    officialWorkflowObservation$: workflowContext.officialWorkflowObservation$,
    workflowSkills$: workflowContext.workflowSkills$,
    storage$: workflowContext.storage$,
    storageCache$: workflowContext.storageCache$,
    templates$,
    queuedModel$: model.queuedModel$,
    subscriptionSelection$: model.subscriptionSelection$,
    requestedFramework$: model.requestedFramework$,
    modelRoute$: model.modelRoute$,
    providerFramework$: model.providerFramework$,
    dispatchTiming$: model.dispatchTiming$,
    connectorSelection$: connectedAccounts.connectorSelection$,
    connectorSnapshot$: connectedAccounts.connectorSnapshot$,
    connectorThreadSelections$: connectedAccounts.threadSelections$,
    selectedConnectorSources$:
      connectedAccounts.selectedStoredConnectorSources$,
  };
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
