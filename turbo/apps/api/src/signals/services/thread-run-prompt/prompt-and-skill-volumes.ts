import { computed, type Computed } from "ccstate";
import type { AgentRunContextSignals } from "../agent-run-context.signals";
import { createConnectorsContext } from "../connectors-context.service";
import {
  mergeRunPromptAndSkills,
  renderRunPrompts,
  type SkillVolume,
} from "../run-prompt-and-skills";
import { createSystemSkillsContext } from "../system-skills-context.service";
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

export interface PromptAndSkillVolumes {
  readonly appendedSystemPrompt: string;
  readonly userPrompt: string;
  readonly skillVolumes: readonly SkillVolume[];
}

export class PromptAndSkillVolumesError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PromptAndSkillVolumesError";
  }
}

function createIntegrationPrompts(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  featureSwitches$: AgentRunContextSignals["featureSwitches$"],
  threadContext: ThreadContext,
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
    agentphone: createAgentPhoneThreadPrompt(
      pickedEvent$,
      threadContext.agentPhoneContext$,
      featureSwitches$,
    ),
    discord: createDiscordThreadPrompt(
      pickedEvent$,
      threadContext.discordContext$,
      featureSwitches$,
    ),
    automation: createAutomationThreadPrompt(
      pickedEvent$,
      threadContext.automationContext$,
    ),
  };
}

function createExecutionPromptSources(bootstrap: AgentRunContextSignals) {
  const agent$ = computed((get) => {
    return get(bootstrap.agent$);
  });
  const memberMetadata$ = computed((get) => {
    return get(bootstrap.memberMetadata$);
  });
  const featureSwitches$ = computed((get) => {
    return get(bootstrap.featureSwitches$);
  });
  const memberRoutes$ = computed((get) => {
    return get(bootstrap.memberRoutes$);
  });
  const authorizedConnectors$ = computed((get) => {
    return get(bootstrap.authorizedConnectors$);
  });
  const workflowSkills$ = computed((get) => {
    return get(bootstrap.workflowSkills$);
  });
  const selectedImageModel$ = computed((get) => {
    return get(bootstrap.selectedImageModel$);
  });
  return {
    agent$,
    memberMetadata$,
    featureSwitches$,
    memberRoutes$,
    authorizedConnectors$,
    workflowSkills$,
    selectedImageModel$,
  };
}

/** Render prompt contributions once; storage preparation binds skill paths. */
export function createPromptAndSkillVolumesSignals(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
): Computed<Promise<PromptAndSkillVolumes>> {
  const sources = createExecutionPromptSources(bootstrap);
  const {
    agent$,
    memberMetadata$,
    featureSwitches$,
    memberRoutes$,
    authorizedConnectors$,
    workflowSkills$,
    selectedImageModel$,
  } = sources;
  const modelCatalog$ = computed((get) => {
    return get(bootstrap.modelCatalog$);
  });
  const cloudBrowserEnabled$ = computed(async (get) => {
    const thread = (await get(pickedEvent$))?.thread;
    if (!thread) {
      throw new Error("Agent prompt requires a chat thread");
    }
    return thread.cloudBrowserEnabled;
  });
  const integrationPrompts = createIntegrationPrompts(
    pickedEvent$,
    featureSwitches$,
    threadContext,
  );
  const agentPrompt$ = createAgentPrompt(
    agent$,
    featureSwitches$,
    cloudBrowserEnabled$,
  );
  const userPrompt$ = createUserPrompt(memberMetadata$);
  const computerUsePrompt$ = createComputerUsePrompt(
    pickedEvent$,
    threadContext.computerUseHostGrant$,
  );
  const rotatedPrompt$ = createRotatedPrompt(
    pickedEvent$,
    threadContext.session$,
    memberRoutes$,
    modelCatalog$,
    featureSwitches$,
  );
  const connectors$ = createConnectorsContext(authorizedConnectors$);
  const runtimePrompt$ = createRuntimePrompt(selectedImageModel$);
  const systemSkills$ = createSystemSkillsContext();

  return computed(async (get): Promise<PromptAndSkillVolumes> => {
    const contextType = (await get(pickedEvent$))?.contextType;
    if (!contextType) {
      throw new PromptAndSkillVolumesError(
        "CONFLICT",
        "This conversation is no longer available.",
      );
    }
    const automation = contextType === "automation";
    const [
      integration,
      continuation,
      templates,
      agent,
      user,
      computerUse,
      connectors,
      workflows,
      systemSkills,
      runtime,
    ] = await Promise.all([
      get(integrationPrompts[contextType]),
      automation ? null : get(rotatedPrompt$),
      automation ? null : get(threadContext.templates$),
      get(agentPrompt$),
      get(userPrompt$),
      get(computerUsePrompt$),
      get(connectors$),
      get(workflowSkills$),
      get(systemSkills$),
      get(runtimePrompt$),
    ]);
    if (!integration) {
      throw new PromptAndSkillVolumesError(
        contextType === "discord" ? "DISCORD_ACCESS_REVOKED" : "CONFLICT",
        contextType === "discord"
          ? "This Discord conversation is no longer available."
          : "This conversation is no longer available.",
      );
    }
    if (templates && "error" in templates) {
      throw new PromptAndSkillVolumesError(
        templates.error.code,
        templates.error.message,
      );
    }
    const combined = mergeRunPromptAndSkills([
      agent,
      integration,
      ...(continuation ? [continuation] : []),
      ...(templates ? [templates] : []),
      user,
      computerUse,
      connectors,
      workflows,
      systemSkills,
      runtime,
    ]);
    const prompts = renderRunPrompts(combined);
    return {
      appendedSystemPrompt: prompts.systemPrompt,
      userPrompt: prompts.userPrompt,
      skillVolumes: combined.skillVolumes,
    };
  });
}
