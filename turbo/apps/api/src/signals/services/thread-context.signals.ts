import { computerUseHosts } from "@okouai/db/schema/computer-use-host";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { computed, type Computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { db$ } from "../external/db";
import {
  matchAgentRunContextSignals,
  type AgentRunContextSignals,
} from "./agent-run-context.signals";
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

export interface ThreadAgentSelection {
  readonly agentId: string;
  readonly expectedThreadAgentId?: string;
  readonly producerBinding?: {
    readonly kind: "reassign-agent";
    readonly agentId: string;
    readonly expectedAgentId: string;
    readonly userId: string;
    readonly threadId: string;
    readonly orgId: string;
  };
}

export interface ThreadAutomationTarget {
  readonly automation: typeof workflowAutomations.$inferSelect;
  readonly agentId: string;
}

type ThreadModels = ReturnType<typeof createThreadModelSignals>;

/** Read-only facts for one picked event, shared by admission and prompting. */
export interface ThreadContext {
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
  readonly agentSelection$: Computed<Promise<ThreadAgentSelection | null>>;
  readonly executionBootstrap$: Computed<Promise<AgentRunContextSignals>>;
  /** The picked thread, only while it belongs to the execution identity. */
  readonly executionThread$: Computed<
    Promise<PickedThreadInputEvent["thread"] | null>
  >;
  readonly templates$: ReturnType<typeof createRunTemplates>;
  readonly queuedModel$: ThreadModels["queuedModel$"];
  readonly subscriptionSelection$: ThreadModels["subscriptionSelection$"];
  readonly requestedFramework$: ThreadModels["requestedFramework$"];
  readonly modelRoute$: ThreadModels["modelRoute$"];
  readonly providerFramework$: ThreadModels["providerFramework$"];
  readonly dispatchTiming$: ThreadModels["dispatchTiming$"];
  /** Connector scope and catalog of the execution identity. */
  readonly connectorScope$: ConnectedAccounts["connectorScope$"];
  readonly connectorCatalog$: ConnectedAccounts["connectorCatalog$"];
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
  const agentSelection$ = createThreadAgentSelection(
    bootstrap,
    pickedEvent$,
    orgId,
  );
  const executionBootstrap$ = createThreadExecutionBootstrap(
    bootstrap,
    pickedEvent$,
    automationTarget$,
    agentSelection$,
    orgId,
  );
  const executionThread$ = createExecutionThread(
    pickedEvent$,
    executionBootstrap$,
    agentSelection$,
  );
  const templates$ = createRunTemplates(
    pickedEvent$,
    orgId,
    sourceFeatureSwitches$,
  );
  const computerUseHostGrant$ = createThreadHostGrant(
    thread$,
    executionBootstrap$,
  );
  const model = createThreadModelSignals(
    bootstrap,
    pickedEvent$,
    executionBootstrap$,
  );
  const connectorSourceId$ = createConnectorSourceId(
    pickedEvent$,
    automationContext$,
    feishuContext$,
  );
  const connectedAccounts = createConnectedAccountsSignals(
    pickedEvent$,
    executionBootstrap$,
    executionThread$,
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
    agentSelection$,
    executionBootstrap$,
    executionThread$,
    templates$,
    queuedModel$: model.queuedModel$,
    subscriptionSelection$: model.subscriptionSelection$,
    requestedFramework$: model.requestedFramework$,
    modelRoute$: model.modelRoute$,
    providerFramework$: model.providerFramework$,
    dispatchTiming$: model.dispatchTiming$,
    connectorScope$: connectedAccounts.connectorScope$,
    connectorCatalog$: connectedAccounts.connectorCatalog$,
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
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .where(eq(workflowAutomations.id, event.automationId))
      .limit(1);
    return row ?? null;
  });
}

function createThreadAgentSelection(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  orgId: string,
) {
  return computed(async (get): Promise<ThreadAgentSelection | null> => {
    const event = await get(pickedEvent$);
    if (!event?.agentId) {
      return null;
    }
    if (
      ![
        "slack",
        "feishu",
        "teams",
        "discord",
        "telegram",
        "agentphone",
      ].includes(event.contextType ?? "")
    ) {
      return { agentId: event.agentId };
    }
    const agentId = (await get(bootstrap.orgMetadata$))?.defaultAgentId;
    if (!agentId) {
      return null;
    }
    if (agentId === event.agentId) {
      return { agentId };
    }
    return {
      agentId,
      expectedThreadAgentId: event.agentId,
      producerBinding: {
        kind: "reassign-agent",
        agentId,
        expectedAgentId: event.agentId,
        userId: event.userId,
        threadId: event.chatThreadId,
        orgId,
      },
    };
  });
}

function createExecutionThread(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  executionBootstrap$: ThreadContext["executionBootstrap$"],
  agentSelection$: ThreadContext["agentSelection$"],
) {
  return computed(
    async (get): Promise<PickedThreadInputEvent["thread"] | null> => {
      const event = await get(pickedEvent$);
      if (!event) {
        return null;
      }
      const [execution, agentSelection] = await Promise.all([
        get(executionBootstrap$),
        get(agentSelection$),
      ]);
      const { thread } = event;
      return thread.id === event.chatThreadId &&
        thread.userId === execution.userId &&
        thread.agentId ===
          (agentSelection?.expectedThreadAgentId ?? execution.agentId)
        ? thread
        : null;
    },
  );
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

function createThreadExecutionBootstrap(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationTarget$: ThreadContext["automationTarget$"],
  agentSelection$: ThreadContext["agentSelection$"],
  orgId: string,
) {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (!event) {
      throw new Error("Thread execution requires a picked event");
    }
    if (event.contextType === "automation") {
      const target = await get(automationTarget$);
      if (!target) {
        throw new Error("Automation execution requires its captured target");
      }
      return matchAgentRunContextSignals(
        bootstrap,
        target.automation.ownerUserId,
        target.automation.orgId,
        target.agentId,
      );
    }
    const agent = await get(agentSelection$);
    if (!agent) {
      throw new Error("Prompt preparation lost its selected Agent");
    }
    return matchAgentRunContextSignals(
      bootstrap,
      event.userId,
      orgId,
      agent.agentId,
    );
  });
}

function createThreadHostGrant(
  thread$: Computed<Promise<ChatThreadRequestRow | null>>,
  executionBootstrap$: ThreadContext["executionBootstrap$"],
) {
  return computed(async (get) => {
    const [thread, selected] = await Promise.all([
      get(thread$),
      get(executionBootstrap$),
    ]);
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
