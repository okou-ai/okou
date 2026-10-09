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
  readonly pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>;
  readonly thread$: Computed<Promise<ChatThreadRequestRow | null>>;
  readonly sessionRead$: ReturnType<typeof createChatThreadSessionRead>;
  readonly session$: Computed<
    Promise<ReturnType<typeof chatThreadSessionIdentity>>
  >;
  readonly cloudBrowserEnabled$: Computed<Promise<boolean>>;
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
  readonly agent$: AgentRunContextSignals["agent$"];
  readonly memberMetadata$: AgentRunContextSignals["memberMetadata$"];
  readonly featureSwitches$: AgentRunContextSignals["featureSwitches$"];
  readonly memberRoutes$: AgentRunContextSignals["memberRoutes$"];
  readonly modelCatalog$: AgentRunContextSignals["modelCatalog$"];
  readonly authorizedConnectors$: AgentRunContextSignals["authorizedConnectors$"];
  readonly workflowSkills$: AgentRunContextSignals["workflowSkills$"];
  readonly selectedImageModel$: AgentRunContextSignals["selectedImageModel$"];
  readonly templates$: ReturnType<typeof createRunTemplates>;
  readonly queuedModel$: ThreadModels["queuedModel$"];
  readonly subscriptionSelection$: ThreadModels["subscriptionSelection$"];
  readonly requestedFramework$: ThreadModels["requestedFramework$"];
  readonly modelRoute$: ThreadModels["modelRoute$"];
  readonly providerFramework$: ThreadModels["providerFramework$"];
  readonly framework$: ThreadModels["framework$"];
  readonly dispatchTiming$: ThreadModels["dispatchTiming$"];
}

export function createThreadContext(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
): ThreadContext {
  const event$ = computed((get) => {
    return get(pickedEvent$);
  });
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
  const cloudBrowserEnabled$ = computed(async (get) => {
    const thread = await get(thread$);
    if (!thread) {
      throw new Error("Agent prompt requires a chat thread");
    }
    return thread.cloudBrowserEnabled;
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
  const agent$ = computed(async (get) => {
    return get((await get(executionBootstrap$)).agent$);
  });
  const memberMetadata$ = computed(async (get) => {
    return get((await get(executionBootstrap$)).memberMetadata$);
  });
  const featureSwitches$ = computed(async (get) => {
    return get((await get(executionBootstrap$)).featureSwitches$);
  });
  const memberRoutes$ = computed(async (get) => {
    return get((await get(executionBootstrap$)).memberRoutes$);
  });
  const modelCatalog$ = computed((get) => {
    return get(bootstrap.modelCatalog$);
  });
  const authorizedConnectors$ = computed(async (get) => {
    return get((await get(executionBootstrap$)).authorizedConnectors$);
  });
  const workflowSkills$ = computed(async (get) => {
    return get((await get(executionBootstrap$)).workflowSkills$);
  });
  const selectedImageModel$ = computed(async (get) => {
    return get((await get(executionBootstrap$)).selectedImageModel$);
  });
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
  return {
    pickedEvent$: event$,
    thread$,
    sessionRead$,
    session$,
    cloudBrowserEnabled$,
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
    agent$,
    memberMetadata$,
    featureSwitches$,
    memberRoutes$,
    modelCatalog$,
    authorizedConnectors$,
    workflowSkills$,
    selectedImageModel$,
    templates$,
    queuedModel$: model.queuedModel$,
    subscriptionSelection$: model.subscriptionSelection$,
    requestedFramework$: model.requestedFramework$,
    modelRoute$: model.modelRoute$,
    providerFramework$: model.providerFramework$,
    framework$: model.framework$,
    dispatchTiming$: model.dispatchTiming$,
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

function createThreadExecutionBootstrap(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationTarget$: ThreadContext["automationTarget$"],
  agentSelection$: ThreadContext["agentSelection$"],
  orgId: string,
) {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (event?.contextType === "automation") {
      const target = await get(automationTarget$);
      return target
        ? matchAgentRunContextSignals(
            bootstrap,
            target.automation.ownerUserId,
            target.automation.orgId,
            target.agentId,
          )
        : bootstrap;
    }
    const agent = await get(agentSelection$);
    return event && agent
      ? matchAgentRunContextSignals(
          bootstrap,
          event.userId,
          orgId,
          agent.agentId,
        )
      : bootstrap;
  });
}

function createThreadHostGrant(
  thread$: ThreadContext["thread$"],
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
