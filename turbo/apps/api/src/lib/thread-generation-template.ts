import type { MountedUserTemplate } from "../signals/services/user-template-data.service";
import {
  buildGenerationTemplatePrompt,
  buildGenerationTemplatesPrompt,
  type LiveGenerationTemplate,
} from "./generation-template-prompt";

/**
 * Resolve the generation-template system prompt for a chat run.
 *
 * One-shot only: the prompt is built from the selection attached to *this*
 * message and nothing else. There is no thread-level default: a follow-up
 * message that doesn't reattach a template resolves to "".
 */
export function resolveThreadGenerationTemplatePrompt(args: {
  readonly explicit: LiveGenerationTemplate | null | undefined;
  readonly explicitTemplates?: readonly LiveGenerationTemplate[];
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
}): string {
  const options = {
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
    return built.status === "resolved" ? built.prompt : "";
  }
  if (!args.explicit) {
    return "";
  }
  const explicit = args.explicit;
  const built = buildGenerationTemplatePrompt(explicit, options);
  return built.status === "resolved" ? built.prompt : "";
}
