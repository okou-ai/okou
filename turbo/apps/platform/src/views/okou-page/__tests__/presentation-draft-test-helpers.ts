import type { AgentDraftResponse } from "@okouai/api-contracts/contracts/agent-draft";
import type { PresentationTemplateItem } from "@okouai/core";
import { screen, waitFor } from "@testing-library/react";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";

export function savedPresentationDraft(
  template: PresentationTemplateItem,
): AgentDraftResponse {
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

export async function openSavedPresentationPicker(
  title: string,
): Promise<HTMLElement> {
  const edit = await waitFor(() => {
    const inline = Array.from(
      document.querySelectorAll<HTMLElement>("[data-composer-inline-template]"),
    ).find((candidate) => {
      return candidate.textContent?.includes(title);
    });
    const button = inline && queryAllByRoleFast("button", inline)[0];
    if (!button) {
      throw new Error(`Saved presentation ${title} has no edit control`);
    }
    return button;
  });
  click(edit);
  return await screen.findByRole("dialog");
}
