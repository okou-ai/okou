import type { MountedUserTemplate } from "../signals/services/user-template-data.service";
import {
  buildGenerationTemplatePrompt,
  buildGenerationTemplatesPrompt,
  type LiveGenerationTemplate,
} from "./generation-template-prompt";
import {
  templateUsageIdentities,
  type TemplateUsageIdentity,
} from "./template-usage-identity";

/**
 * Resolve generation-template guidance and usage identities for one message.
 *
 * One-shot only: the prompt is built from the selection attached to *this*
 * message and nothing else. There is no thread-level default: a follow-up
 * message that doesn't reattach a template has no guidance or identities.
 */
export function resolveThreadGenerationTemplates(args: {
  readonly explicit: LiveGenerationTemplate | null | undefined;
  readonly explicitTemplates?: readonly LiveGenerationTemplate[];
  readonly includeManagedImageInstructions: boolean;
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
}): {
  readonly prompt: string;
  readonly identities: readonly TemplateUsageIdentity[];
} {
  const options = {
    includeManagedImageInstructions: args.includeManagedImageInstructions,
    mountedUserPresentationTemplateIds: args.mountedUserPresentationTemplateIds,
    mountedUserTemplates: args.mountedUserTemplates,
  };
  const explicitTemplates = args.explicitTemplates ?? [];
  const templates =
    explicitTemplates.length > 0
      ? explicitTemplates
      : args.explicit
        ? [args.explicit]
        : [];
  if (templates.length === 0) {
    return { prompt: "", identities: [] };
  }
  const built =
    explicitTemplates.length > 0
      ? buildGenerationTemplatesPrompt(explicitTemplates, options)
      : buildGenerationTemplatePrompt(args.explicit, options);
  // The batch builder rejects the whole message when any one selection is
  // invalid, so the templates are either all guidance or none of them are.
  if (built.status !== "resolved") {
    return { prompt: "", identities: [] };
  }
  return {
    prompt: built.prompt,
    identities: templateUsageIdentities(templates, args.mountedUserTemplates),
  };
}
