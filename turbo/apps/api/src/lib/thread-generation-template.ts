import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import {
  brandMotionUnavailableInstructionLines,
  resolveBrandMotionTemplate,
} from "@okouai/core/brand-motion-template-items";
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
 * on, so reporting it as used would overstate the template's reach. An
 * unavailable Brand motion contributes only an explanation, never a usage.
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
  readonly brandMotionEnabled: boolean;
  /**
   * Private template row ids whose packages the run being built will mount.
   * Required rather than optional so every caller states what its run carries.
   */
  readonly mountedUserPresentationTemplateIds: readonly string[];
}): ResolvedThreadGenerationTemplates {
  const selections = args.explicitTemplates?.length
    ? args.explicitTemplates
    : args.explicit
      ? [args.explicit]
      : [];
  // A previously admitted queued/steered selection may lose access or its
  // resource before delivery. Preserve the rejection in context so removing
  // executable guidance cannot silently turn it into generic video generation.
  for (const selection of selections) {
    if (selection.type === "brand-motion") {
      const resolved = resolveBrandMotionTemplate(
        selection.selection.templateId,
        args.brandMotionEnabled,
      );
      if (resolved.status === "invalid") {
        return {
          prompt: brandMotionUnavailableInstructionLines(resolved.message).join(
            "\n",
          ),
          identities: [],
        };
      }
    }
  }
  const options = {
    introVideoEnabled: args.introVideoEnabled,
    brandMotionEnabled: args.brandMotionEnabled,
    mountedUserPresentationTemplateIds: args.mountedUserPresentationTemplateIds,
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
