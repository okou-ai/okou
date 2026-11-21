import {
  mergeRunPrompt,
  renderRunPrompts,
  type SkillVolume,
  type SystemPromptVariables,
} from "../run-prompt-and-skills";
import { createPhoneUsePrompt } from "./phone-use";
import { createEmailThreadPrompt } from "./email";
import { createSuggestionsPrompt } from "./suggestions";
import { createWechatThreadPrompt } from "./wechat";
import { computed, type Computed } from "ccstate";
import type { AgentRunContextSignals } from "../agent-run-context.signals";
import { createConnectorsContext } from "../connectors-context.service";
import { createSystemSkillVolumes } from "../system-skills-context.service";
import type { ThreadContext } from "../thread-context.signals";
import { createAgentPrompt } from "./agent";
import { createAgentPhoneThreadPrompt } from "./agentphone";
import { createAutomationThreadPrompt } from "./automation";
import { createComputerUsePrompt } from "./computer-use";
import { createDiscordThreadPrompt } from "./discord";
import { createFeishuThreadPrompt } from "./feishu";
import { createRotatedPrompt } from "./rotated";
import { createRuntimePrompt } from "./runtime";
import { createSlackThreadPrompt } from "./slack";
import { createTeamsThreadPrompt } from "./teams";
import { createTelegramThreadPrompt } from "./telegram";
import type { PickedThreadInputEvent } from "./types";
import { createUserPrompt } from "./user";
import { createWebThreadPrompt } from "./web";

export interface PreparedRunPrompt {
  readonly systemPromptVariables: SystemPromptVariables;
  readonly appendedSystemPrompt: string;
  readonly userPrompt: string;
  readonly userTimezone: string | undefined;
}

export class RunPromptError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunPromptError";
  }
}

function unavailablePromptContext(
  contextType?: PickedThreadInputEvent["contextType"],
) {
  return new RunPromptError(
    contextType === "discord" ? "DISCORD_ACCESS_REVOKED" : "CONFLICT",
    contextType === "discord"
      ? "This Discord conversation is no longer available."
      : "This conversation is no longer available.",
  );
}

function createIntegrationPrompts(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  featureSwitches$: AgentRunContextSignals["featureSwitches$"],
  threadContext: ThreadContext,
  singleAgent$: Computed<Promise<boolean>>,
) {
  const framework$ = computed(async (get) => {
    const framework = await get(threadContext.providerFramework$);
    if (typeof framework !== "string") {
      throw new Error("Runtime prompt requires a valid run model route");
    }
    return framework;
  });
  const webPrompt$ = createWebThreadPrompt(
    pickedEvent$,
    featureSwitches$,
    framework$,
    singleAgent$,
    threadContext.projectContext$,
  );
  return {
    web: webPrompt$,
    agent_run: webPrompt$,
    slack: createSlackThreadPrompt(
      pickedEvent$,
      threadContext.slackContext$,
      featureSwitches$,
    ),
    feishu: createFeishuThreadPrompt(
      pickedEvent$,
      threadContext.feishuContext$,
      featureSwitches$,
    ),
    teams: createTeamsThreadPrompt(
      pickedEvent$,
      threadContext.teamsContext$,
      featureSwitches$,
    ),
    telegram: createTelegramThreadPrompt(
      pickedEvent$,
      threadContext.telegramContext$,
      featureSwitches$,
    ),
    email: createEmailThreadPrompt(
      threadContext.emailContext$,
      featureSwitches$,
      threadContext.emailMailboxConnections$,
    ),
    agentphone: createAgentPhoneThreadPrompt(
      pickedEvent$,
      threadContext.agentPhoneContext$,
      featureSwitches$,
    ),
    wechat: createWechatThreadPrompt(threadContext.wechatContext$),
    discord: createDiscordThreadPrompt(
      pickedEvent$,
      threadContext.discordContext$,
      featureSwitches$,
    ),
    automation: createAutomationThreadPrompt(
      threadContext.automationSnapshot$,
      threadContext.automationPayload$,
      singleAgent$,
    ),
  };
}

function createSharedPromptSources(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
) {
  const featureSwitches$ = computed((get) => {
    return get(bootstrap.featureSwitches$);
  });
  const disabledPaidTools$ = computed((get) => {
    return get(bootstrap.disabledPaidTools$);
  });
  const seedSkills$ = computed((get) => {
    return get(bootstrap.seedSkills$);
  });
  const contextType$ = computed(async (get) => {
    const event = await get(pickedEvent$);
    if (!event?.contextType) {
      throw unavailablePromptContext();
    }
    return event.contextType;
  });
  const singleAgent$ = computed(async (get) => {
    return (await get(featureSwitches$)).personalExecution;
  });
  const authorizedConnectors$ = computed(async (get) => {
    const [connectors, selection] = await Promise.all([
      get(bootstrap.authorizedConnectors$),
      get(threadContext.connectorSelection$),
    ]);
    if ("status" in selection) {
      throw new Error("Connector prompt requires an available Chat");
    }
    const scope = selection.connectorScope;
    return connectors.filter((connector) => {
      return connector.kind === "builtin"
        ? scope.allowedConnectorSlugs.includes(connector.connectorSlug)
        : scope.allowedCustomConnectorIds.includes(connector.customConnectorId);
    });
  });
  const connectors$ = createConnectorsContext(
    authorizedConnectors$,
    singleAgent$,
  );
  const templates$ = computed(async (get) => {
    if ((await get(contextType$)) === "automation") {
      return null;
    }
    const templates = await get(threadContext.templates$);
    if ("error" in templates) {
      throw new RunPromptError(templates.error.code, templates.error.message);
    }
    return templates;
  });
  const systemSkills$ = createSystemSkillVolumes(
    disabledPaidTools$,
    seedSkills$,
  );
  const skillVolumes$ = computed(
    async (get): Promise<readonly SkillVolume[]> => {
      const [templates, connectors, systemSkills] = await Promise.all([
        get(templates$),
        get(connectors$),
        get(systemSkills$),
      ]);
      return [
        ...(templates?.skillVolumes ?? []),
        ...connectors.skillVolumes,
        ...systemSkills,
      ];
    },
  );
  return {
    featureSwitches$,
    disabledPaidTools$,
    contextType$,
    singleAgent$,
    connectors$,
    templates$,
    skillVolumes$,
  };
}

/** Share template and Connector contributions between the prompt and package plans. */
export function createPromptAndSkillVolumesSignals(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
) {
  const memberMetadata$ = computed((get) => {
    return get(bootstrap.memberMetadata$);
  });
  const selectedImageModel$ = computed((get) => {
    return get(bootstrap.selectedImageModel$);
  });
  const shared = createSharedPromptSources(
    bootstrap,
    pickedEvent$,
    threadContext,
  );
  const {
    contextType$,
    singleAgent$,
    templates$,
    connectors$,
    featureSwitches$,
    disabledPaidTools$,
  } = shared;
  const cloudBrowserEnabled$ = createCloudBrowserEnabled(pickedEvent$);
  const integrationPrompts = createIntegrationPrompts(
    pickedEvent$,
    featureSwitches$,
    threadContext,
    singleAgent$,
  );
  const agentPrompt$ = createAgentPrompt(
    featureSwitches$,
    cloudBrowserEnabled$,
    disabledPaidTools$,
    singleAgent$,
  );
  const suggestionsPrompt$ = createSuggestionsPrompt(
    bootstrap,
    pickedEvent$,
    threadContext,
  );
  const userPrompt$ = createUserPrompt(memberMetadata$);
  const deviceUsePrompts = createDeviceUsePrompts(
    pickedEvent$,
    featureSwitches$,
  );
  const { computerUsePrompt$, phoneUsePrompt$ } = deviceUsePrompts;
  const rotatedPrompt$ = createRotatedPrompt(threadContext.incompleteContext$);
  const runtimePrompt$ = createRuntimePrompt(
    selectedImageModel$,
    disabledPaidTools$,
  );
  const prompt$ = computed(async (get): Promise<PreparedRunPrompt> => {
    const contextType = await get(contextType$);
    const [
      integration,
      continuation,
      templates,
      agent,
      user,
      computerUse,
      phoneUse,
      connectors,
      runtime,
      suggestions,
    ] = await Promise.all([
      get(integrationPrompts[contextType]),
      contextType === "automation" ? null : get(rotatedPrompt$),
      get(templates$),
      get(agentPrompt$),
      get(userPrompt$),
      get(computerUsePrompt$),
      get(phoneUsePrompt$),
      get(connectors$),
      get(runtimePrompt$),
      get(suggestionsPrompt$),
    ]);
    if (!integration) {
      throw unavailablePromptContext(contextType);
    }
    const combined = mergeRunPrompt([
      agent,
      integration,
      ...(continuation ? [continuation] : []),
      ...(templates ? [templates] : []),
      user,
      computerUse,
      phoneUse,
      connectors,
      runtime,
      suggestions,
    ]);
    const prompts = renderRunPrompts(combined);
    return {
      systemPromptVariables: combined.systemPromptVariables,
      appendedSystemPrompt: prompts.systemPrompt,
      userPrompt: prompts.userPrompt,
      // createUserPrompt already consumed this memoized member observation.
      userTimezone:
        (await get(memberMetadata$)).preferences?.timezone ?? undefined,
    };
  });
  return { prompt$, skillVolumes$: shared.skillVolumes$ };
}

function createDeviceUsePrompts(
  event$: Parameters<typeof createComputerUsePrompt>[0],
  features$: Parameters<typeof createComputerUsePrompt>[1],
) {
  return {
    computerUsePrompt$: createComputerUsePrompt(event$, features$),
    phoneUsePrompt$: createPhoneUsePrompt(event$, features$),
  };
}

function createCloudBrowserEnabled(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
) {
  return computed(async (get) => {
    const thread = (await get(pickedEvent$))?.thread;
    if (!thread) {
      throw new Error("Agent prompt requires a chat thread");
    }
    return thread.cloudBrowserEnabled;
  });
}
