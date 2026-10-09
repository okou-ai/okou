import { computed, type Computed } from "ccstate";
import { systemSkillStorageResolution$ } from "../../context/system-skill-storage-resolution";
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
import { createUserPrompt } from "./user";
import { createWebThreadPrompt } from "./web";

export type PromptAndSkillVolumesInputs = Pick<
  ThreadContext,
  | "pickedEvent$"
  | "agent$"
  | "memberMetadata$"
  | "featureSwitches$"
  | "cloudBrowserEnabled$"
  | "slackContext$"
  | "feishuContext$"
  | "teamsContext$"
  | "telegramContext$"
  | "agentPhoneContext$"
  | "discordContext$"
  | "automationContext$"
  | "session$"
  | "memberRoutes$"
  | "modelCatalog$"
  | "templates$"
  | "authorizedConnectors$"
  | "workflowSkills$"
  | "selectedImageModel$"
  | "providerFramework$"
  | "computerUseHostGrant$"
>;

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

function createIntegrationPrompts(inputs: PromptAndSkillVolumesInputs) {
  const { pickedEvent$, featureSwitches$ } = inputs;
  const framework$ = computed(async (get) => {
    const framework = await get(inputs.providerFramework$);
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
      inputs.slackContext$,
      featureSwitches$,
    ),
    feishu: createFeishuThreadPrompt(
      pickedEvent$,
      inputs.feishuContext$,
      featureSwitches$,
    ),
    teams: createTeamsThreadPrompt(
      pickedEvent$,
      inputs.teamsContext$,
      featureSwitches$,
    ),
    telegram: createTelegramThreadPrompt(
      pickedEvent$,
      inputs.telegramContext$,
      featureSwitches$,
    ),
    agentphone: createAgentPhoneThreadPrompt(
      pickedEvent$,
      inputs.agentPhoneContext$,
      featureSwitches$,
    ),
    discord: createDiscordThreadPrompt(
      pickedEvent$,
      inputs.discordContext$,
      featureSwitches$,
    ),
    automation: createAutomationThreadPrompt(
      pickedEvent$,
      inputs.automationContext$,
    ),
  };
}

/** Render prompt contributions once; storage preparation binds skill paths. */
export function createPromptAndSkillVolumesSignals(
  inputs: PromptAndSkillVolumesInputs,
): Computed<Promise<PromptAndSkillVolumes>> {
  const pickedEvent$ = inputs.pickedEvent$;
  const integrationPrompts = createIntegrationPrompts(inputs);
  const agentPrompt$ = createAgentPrompt(
    inputs.agent$,
    inputs.featureSwitches$,
    inputs.cloudBrowserEnabled$,
  );
  const userPrompt$ = createUserPrompt(inputs.memberMetadata$);
  const computerUsePrompt$ = createComputerUsePrompt(
    pickedEvent$,
    inputs.computerUseHostGrant$,
  );
  const rotatedPrompt$ = createRotatedPrompt(
    pickedEvent$,
    inputs.session$,
    inputs.memberRoutes$,
    inputs.modelCatalog$,
  );
  const connectors$ = createConnectorsContext(inputs.authorizedConnectors$);
  const runtimePrompt$ = createRuntimePrompt(inputs.selectedImageModel$);
  const systemSkills$ = createSystemSkillsContext(
    systemSkillStorageResolution$,
  );

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
      automation ? null : get(inputs.templates$),
      get(agentPrompt$),
      get(userPrompt$),
      get(computerUsePrompt$),
      get(connectors$),
      get(inputs.workflowSkills$),
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
