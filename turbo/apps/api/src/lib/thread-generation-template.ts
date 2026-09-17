import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { MountedUserTemplate } from "../signals/services/user-template-data.service";
import {
  generationTemplateIdentity,
  type GenerationTemplateIdentity,
} from "@okouai/core/generation-template-identity";
import {
  buildGenerationTemplatePrompt,
  buildGenerationTemplatesPrompt,
} from "./generation-template-prompt";

/**
 * The prompt for a chat run, plus the selections that actually reached it.
 *
 * `identities` is what usage reporting counts. It is empty whenever the prompt
 * is empty: a selection the builder rejected — a switch that is off, a private
 * package this run does not mount — never becomes guidance the agent can act
 * on, so reporting it as used would overstate the template's reach.
 */
interface ResolvedThreadGenerationTemplates {
  readonly prompt: string;
  readonly identities: readonly GenerationTemplateIdentity[];
}

function noGenerationTemplates(): ResolvedThreadGenerationTemplates {
  return { prompt: "", identities: [] };
}

/**
 * Resolve the generation-template system prompt for a chat run.
 *
 * One-shot only: the prompt is built from the selection attached to *this*
 * message and nothing else. There is no thread-level default: a follow-up
 * message that doesn't reattach a template resolves to "".
 */
export function resolveThreadGenerationTemplatePrompt(args: {
  readonly explicit: GenerationTemplateRequest | null | undefined;
  readonly explicitTemplates?: readonly GenerationTemplateRequest[];
  readonly introVideoEnabled: boolean;
  /**
   * Private template row ids whose packages the run being built will mount.
   * Required rather than optional so every caller states what its run carries.
   */
  readonly mountedUserPresentationTemplateIds: readonly string[];
  /**
   * Custom templates the run being built will mount, with the kind each row
   * says it is. Required for the same reason as the ids above.
   */
  readonly mountedUserTemplates: readonly MountedUserTemplate[];
}): ResolvedThreadGenerationTemplates {
  const options = {
    introVideoEnabled: args.introVideoEnabled,
    mountedUserPresentationTemplateIds: args.mountedUserPresentationTemplateIds,
    mountedUserTemplates: args.mountedUserTemplates,
  };
  if (args.explicitTemplates && args.explicitTemplates.length > 0) {
    const built = buildGenerationTemplatesPrompt(
      args.explicitTemplates,
      options,
    );
    // The batch builder rejects the whole message when any one selection is
    // invalid, so the templates are either all guidance or none of them are.
    return built.status === "resolved"
      ? {
          prompt: built.prompt,
          identities: args.explicitTemplates.map(generationTemplateIdentity),
        }
      : noGenerationTemplates();
  }
  if (!args.explicit) {
    return noGenerationTemplates();
  }
  const explicit = args.explicit;
  const built = buildGenerationTemplatePrompt(explicit, options);
  return built.status === "resolved"
    ? {
        prompt: built.prompt,
        identities: [generationTemplateIdentity(explicit)],
      }
    : noGenerationTemplates();
}
