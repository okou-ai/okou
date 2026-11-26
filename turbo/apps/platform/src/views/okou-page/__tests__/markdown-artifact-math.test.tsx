import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedLink,
  mockAttachmentChat,
  publicArtifactUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

const FILENAME = "subshell-closure.md";
const DOCUMENT = [
  "# Subshell closure",
  "",
  String.raw`The inline count \(1s^2\,2s^2\) closes the shell.`,
  "",
  String.raw`\[ \mathrm C^{2+}\!:1s^2\,2s^2, \qquad \mathrm{Ni}^{2-}\!:[\mathcal K_{26}]\,4d^4. \tag{19} \]`,
  "",
  "$$",
  String.raw`E = mc^2`,
  "$$",
  "",
  "Lunch costs $5 to $10.",
  "",
  "```",
  String.raw`\[ z = 1 \]`,
  "```",
].join("\n");

async function openDocument() {
  const url = publicArtifactUrl(FILENAME);
  context.mocks.http.get(url, () => {
    return HttpResponse.text(DOCUMENT);
  });
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "math-document-message",
        role: "assistant",
        content: `The [${FILENAME}](${url}) is ready.`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "math-document-output",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
    artifacts: [artifactFile(FILENAME, { contentType: "text/markdown" })],
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  click(await findNamedLink(FILENAME));
  return within(await screen.findByTestId("artifact-sidebar")).findByRole(
    "document",
  );
}

test("Markdown artifact previews render explicit formulas like Agent messages", async () => {
  const document = await openDocument();

  await waitFor(() => {
    expect(
      document.querySelectorAll('[data-math-status="rendered"]'),
    ).toHaveLength(3);
  });
  for (const formula of document.querySelectorAll(
    '[data-math-status="rendered"]',
  )) {
    expect(formula.querySelector("math")).not.toBeNull();
  }
  expect(
    [...document.querySelectorAll('[data-math-status="rendered"]')].map(
      (formula) => {
        return formula.tagName;
      },
    ),
  ).toStrictEqual(["SPAN", "DIV", "DIV"]);
  expect(within(document).getByText("Lunch costs $5 to $10.")).toBeVisible();
  const code = document.querySelector("pre code");
  expect(code?.textContent?.trim()).toBe(String.raw`\[ z = 1 \]`);
  expect(code?.querySelector("[data-math-status]")).toBeNull();
});
