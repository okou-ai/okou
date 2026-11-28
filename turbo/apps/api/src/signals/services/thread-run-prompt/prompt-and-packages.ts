import { proactiveInstructions } from "../proactive-run-context.service";
import {
  mergeRunPrompt,
  renderRunPrompts,
  type SystemPromptVariables,
} from "../run-prompt-and-skills";
import { createPhoneUsePrompt } from "./phone-use";
import { createEmailThreadPrompt } from "./email";
import { createSuggestionsPrompt } from "./suggestions";
import { createWechatThreadPrompt } from "./wechat";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import { computed, type Computed } from "ccstate";
import type { AgentRunContextSignals } from "../agent-run-context.signals";
import { createConnectorsContext } from "../connectors-context.service";
import { launchFrameworkForProviderType } from "../launch-framework";
import { createSystemSkills } from "../system-skills-context.service";
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
  readonly selectedImageModel: ImageModel | null;
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
) {
  const framework$ = computed(async (get) => {
    const model = await get(threadContext.modelRoute$);
    if ("status" in model) {
      throw new Error("Runtime prompt requires a valid run model route");
    }
    return launchFrameworkForProviderType(model.type);
  });
  const webPrompt$ = createWebThreadPrompt(
    pickedEvent$,
    featureSwitches$,
    framework$,
    threadContext.projectContext$,
  );
  return {
    proactive: computed(async (get) => {
      const source = await get(threadContext.proactiveInput$);
      if (!source) {
        return null;
      }
      const permission =
        source.task === "morning-brief" && !source.suggestionsEnabled
          ? "\nSuggestions are disabled for this Morning Brief. Skip all Suggestions maintenance."
          : "";
      return {
        userPromptVariables: {
          message: [
            proactiveInstructions[source.task],
            `Scheduled occurrence (UTC): ${source.scheduledAt.toISOString()}`,
            permission,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        systemPromptVariables: {},
      };
    }),
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
  const contextType$ = computed(async (get) => {
    const event = await get(pickedEvent$);
    if (!event?.contextType) {
      throw unavailablePromptContext();
    }
    return event.contextType;
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
  const connectors$ = createConnectorsContext(authorizedConnectors$);
  const templates$ = computed(async (get) => {
    const type = await get(contextType$);
    if (type === "automation" || type === "proactive") {
      return null;
    }
    const templates = await get(threadContext.templates$);
    if ("error" in templates) {
      throw new RunPromptError(templates.error.code, templates.error.message);
    }
    return templates;
  });
  const systemSkills$ = createSystemSkills(
    disabledPaidTools$,
    threadContext.executionPackageSources$,
  );
  const packageSources$ = computed(async (get) => {
    const [templates, connectors, systemSkills] = await Promise.all([
      get(templates$),
      get(connectors$),
      get(systemSkills$),
    ]);
    return {
      templateGuidanceBundles: templates?.templateGuidanceBundles ?? [],
      customConnectorSkills: connectors.customConnectorSkills,
      builtinConnectorSkills: connectors.builtinConnectorSkills,
      systemSkills,
    };
  });
  return {
    featureSwitches$,
    disabledPaidTools$,
    contextType$,
    connectors$,
    templates$,
    packageSources$,
  };
}

/** Share template and Connector contributions between the prompt and package plans. */
export function createPromptAndPackageSignals(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
) {
  const memberMetadata$ = computed((get) => {
    return get(bootstrap.memberMetadata$);
  });
  const shared = createSharedPromptSources(
    bootstrap,
    pickedEvent$,
    threadContext,
  );
  const {
    contextType$,
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
  );
  const agentPrompt$ = createAgentPrompt(
    featureSwitches$,
    cloudBrowserEnabled$,
    disabledPaidTools$,
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
    memberMetadata$,
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
      contextType === "automation" || contextType === "proactive"
        ? null
        : get(rotatedPrompt$),
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
      runtime.prompt,
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
      selectedImageModel: runtime.selectedImageModel,
    };
  });
  return {
    prompt$,
    packageSources$: shared.packageSources$,
    suggestionsPrompt$,
  };
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
