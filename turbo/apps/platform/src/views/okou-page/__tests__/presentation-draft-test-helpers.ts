import type { ComposerDraftResponse } from "@okouai/api-contracts/contracts/composer-draft";
import type { PresentationTemplateItem } from "@okouai/core";

export function savedPresentationDraft(
  template: PresentationTemplateItem,
): ComposerDraftResponse {
  return {
    draftUserMessage: {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: template.title,
          template: {
            type: "presentation",
            selection: { templateId: template.templateId },
          },
        },
      ],
    },
    draftAttachments: null,
  };
}
