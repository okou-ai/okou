import { computed, type Computed } from "ccstate";
import { createConnectorsContext } from "../connectors-context.service";
import {
  mergeRunPromptAndSkills,
  renderRunPrompts,
  type RunPromptAndSkills,
  type SkillVolume,
} from "../run-prompt-and-skills";
import type { createRunTemplates } from "../run-templates.service";
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
import type { ThreadPromptSource } from "./types";
import { createUserPrompt } from "./user";
import { createWebThreadPrompt } from "./web";

export interface PromptAndSkillVolumesInputs {
  readonly source$: Computed<Promise<ThreadPromptSource | null>>;
  readonly agent$: Parameters<typeof createAgentPrompt>[0];
  readonly memberMetadata$: Parameters<typeof createUserPrompt>[0];
  readonly featureSwitches$: Parameters<typeof createAgentPrompt>[1];
  readonly cloudBrowserEnabled$: Parameters<typeof createAgentPrompt>[2];
  readonly slackContext$: Parameters<typeof createSlackThreadPrompt>[1];
  readonly feishuContext$: Parameters<typeof createFeishuThreadPrompt>[1];
  readonly teamsContext$: Parameters<typeof createTeamsThreadPrompt>[1];
  readonly telegramContext$: Parameters<typeof createTelegramThreadPrompt>[1];
  readonly agentPhoneContext$: Parameters<
    typeof createAgentPhoneThreadPrompt
  >[1];
  readonly discordContext$: Parameters<typeof createDiscordThreadPrompt>[1];
  readonly automationContext$: Parameters<
    typeof createAutomationThreadPrompt
  >[1];
  readonly session$: Parameters<typeof createRotatedPrompt>[1];
  readonly memberRoutes$: Parameters<typeof createRotatedPrompt>[2];
  readonly catalog$: Parameters<typeof createRotatedPrompt>[3];
  // Admission shares this selection; keep one template read per claim.
  readonly templates$: ReturnType<typeof createRunTemplates>;
  readonly authorizedConnectors$: Parameters<typeof createConnectorsContext>[0];
  readonly workflowSkills$: Computed<Promise<RunPromptAndSkills>>;
  readonly systemSkills$: Computed<Promise<RunPromptAndSkills>>;
  readonly runtime$: Parameters<typeof createRuntimePrompt>[0];
  readonly computerUseHostGrant$: Parameters<typeof createComputerUsePrompt>[1];
}

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

/** Render prompt contributions once; storage preparation binds skill paths. */
export function createPromptAndSkillVolumesSignals(
  inputs: PromptAndSkillVolumesInputs,
): Computed<Promise<PromptAndSkillVolumes>> {
  const pickedEvent$ = computed(async (get) => {
    return (await get(inputs.source$))?.event ?? null;
  });
  const webPrompt$ = createWebThreadPrompt(inputs.source$);
  const integrationPrompts = {
    web: webPrompt$,
    agent_run: webPrompt$,
    slack: createSlackThreadPrompt(inputs.source$, inputs.slackContext$),
    feishu: createFeishuThreadPrompt(inputs.source$, inputs.feishuContext$),
    teams: createTeamsThreadPrompt(inputs.source$, inputs.teamsContext$),
    telegram: createTelegramThreadPrompt(
      inputs.source$,
      inputs.telegramContext$,
    ),
    agentphone: createAgentPhoneThreadPrompt(
      inputs.source$,
      inputs.agentPhoneContext$,
    ),
    discord: createDiscordThreadPrompt(inputs.source$, inputs.discordContext$),
    automation: createAutomationThreadPrompt(
      inputs.source$,
      inputs.automationContext$,
    ),
  };
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
    inputs.catalog$,
  );
  const connectors$ = createConnectorsContext(inputs.authorizedConnectors$);
  const runtimePrompt$ = createRuntimePrompt(inputs.runtime$);

  return computed(async (get): Promise<PromptAndSkillVolumes> => {
    const contextType = (await get(inputs.source$))?.event.contextType;
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
      get(inputs.systemSkills$),
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
