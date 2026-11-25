import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { HttpResponse } from "msw";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChatRunFixtures } from "./chat-run-test-fixtures.ts";
import type { mockChatLifecycle } from "./chat-test-helpers.ts";

type Sent = Parameters<
  NonNullable<
    NonNullable<Parameters<typeof mockChatLifecycle>[1]>["onSendRequest"]
  >
>[0];
export function captureTemplateSubmission(
  context: TestContext,
  onThreadCreate?: NonNullable<
    Parameters<typeof mockChatLifecycle>[1]
  >["onThreadCreate"],
) {
  const sent = context.mocks.deferred<Sent>();
  createChatRunFixtures(context).installRunChat({
    onThreadCreate,
    onSendRequest(body) {
      sent.resolve(body);
    },
  });
  return sent;
}
export const deck = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
export function presentationPart(colorSystemId = deck.colorSystemId) {
  return {
    type: "template" as const,
    titleSnapshot: deck.title,
    template: {
      type: "presentation" as const,
      selection: {
        templateId: deck.templateId,
        colorSystemId,
        previewUrl: deck.embedUrl,
      },
    },
  };
}
export function serveDeck(context: TestContext, slides: string) {
  context.mocks.http.get(deck.embedUrl, () => {
    return HttpResponse.html(
      "<!doctype html><html><body>" + slides + "</body></html>",
    );
  });
}
