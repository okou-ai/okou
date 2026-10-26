import type { RefinementCtx } from "zod";

export function requireUserMessageForDraftAttachments(
  draft: {
    readonly draftUserMessage: unknown;
    readonly draftAttachments?: readonly unknown[] | null;
  },
  context: RefinementCtx,
): void {
  if (
    (draft.draftAttachments?.length ?? 0) > 0 &&
    draft.draftUserMessage === null
  ) {
    context.addIssue({
      code: "custom",
      message: "draftUserMessage is required for draft attachments",
      path: ["draftUserMessage"],
    });
  }
}
