import { describe, expect, it } from "vitest";

import {
  composerDraftRequestSchema,
  composerDraftResponseSchema,
} from "../composer-draft";

describe("composer draft contract", () => {
  it("accepts canonical composer draft responses", () => {
    const response = {
      draftUserMessage: {
        version: 1 as const,
        parts: [{ type: "text" as const, text: "Resume work" }],
      },
      draftAttachments: null,
    };

    expect(composerDraftResponseSchema.parse(response)).toStrictEqual(response);
  });

  it("requires userMessage for non-empty composer drafts", () => {
    expect(
      composerDraftRequestSchema.safeParse({
        draftUserMessage: null,
        draftAttachments: null,
      }),
    ).toMatchObject({ success: true });
    expect(
      composerDraftRequestSchema.safeParse({
        draftUserMessage: null,
        draftAttachments: [
          {
            id: "draft-file",
            filename: "brief.md",
            contentType: "text/markdown",
            size: 42,
            url: "https://example.com/brief.md",
          },
        ],
      }),
    ).toMatchObject({
      success: false,
      error: {
        issues: [
          expect.objectContaining({
            path: ["draftUserMessage"],
          }),
        ],
      },
    });
  });
});
