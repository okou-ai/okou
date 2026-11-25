import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { sharedThreadVisibilityContract } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { findFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import {
  sharedThread,
  SHARED_THREAD_ID,
} from "./shared-thread-test-helpers.ts";
const context = testContext();
const path = "/share/threads/" + SHARED_THREAD_ID;
const url = "https://app.okou.ai" + path;
const question = "Which receipts are still outstanding?";
const responses = [
  "November statement",
  "**December:** documents received",
  "Keep the signed copy.",
] as const;
async function visit(signedIn = false, missing = false) {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return missing
      ? respond(404, {
          error: { code: "NOT_FOUND", message: "Missing shared conversation" },
        })
      : respond(
          200,
          sharedThread({
            title: "Receipts review",
            messages: [
              { role: "user", messageIndex: 0, content: question },
              ...responses.map((content, i) => {
                return {
                  role: "assistant" as const,
                  messageIndex: i + 1,
                  content,
                  runIndex: 1,
                };
              }),
            ],
          }),
        );
  });
  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    auth: signedIn ? undefined : null,
  });
}
async function share() {
  click(await findFastControl("button", "Share"));
  return screen.findByRole("dialog");
}
test("shared-thread-actions-002 An unavailable conversation explains access and offers the visitor sign-in", async () => {
  await visit(false, true);
  await screen.findByText("You can’t view this chat");
  expect(
    screen.getByText(/private or no longer available/i),
  ).toBeInTheDocument();
  await expect(findFastControl("link", "Sign in")).resolves.toHaveAttribute(
    "href",
    expect.stringContaining("/sign-in"),
  );
});
test("shared-thread-actions-005 A visitor copies the question and the entire formatted answer in order", async () => {
  const clip = context.mocks.browser.clipboardWriteText();
  await visit();
  const user = await screen.findByText(question);
  click(
    await findFastControl(
      "button",
      "Copy message",
      user.closest('[data-role="user"]')!,
    ),
  );
  await waitFor(() => {
    return expect(clip.writes.at(-1)).toBe(question);
  });
  await screen.findByText("Copied!");
  const answer = await screen.findByText(responses[2]!);
  click(
    await findFastControl(
      "button",
      "Copy message",
      answer.closest('[data-role="assistant"]')!,
    ),
  );
  await waitFor(() => {
    return expect(clip.writes).toStrictEqual([
      question,
      responses.join("\n\n"),
    ]);
  });
});
test("shared-thread-actions-006 The public share dialog confirms copying the current conversation URL", async () => {
  const clip = context.mocks.browser.clipboardWriteText();
  await visit();
  const dialog = await share();
  click(await findFastControl("button", "Copy link", dialog));
  await findFastControl("button", "Copied", dialog);
  expect(clip.writes.at(-1)).toBe(url);
});
test("shared-thread-actions-009 A signed-in recipient can copy the share link without owner controls", async () => {
  const clip = context.mocks.browser.clipboardWriteText();
  context.mocks.api(sharedThreadVisibilityContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Recipient has no owner settings" },
    });
  });
  await visit(true);
  const dialog = await share();
  click(await findFastControl("button", "Copy link", dialog));
  await findFastControl("button", "Copied", dialog);
  expect(clip.writes.at(-1)).toBe(url);
  expect(within(dialog).queryByRole("radiogroup")).toBeNull();
});
test("shared-thread-actions-007 Workspace ownership stays visible while the creator changes access twice", async () => {
  const clip = context.mocks.browser.clipboardWriteText();
  const oldRevision = crypto.randomUUID(),
    org = { id: "org_123", name: "Receipts team" };
  let current = {
    id: SHARED_THREAD_ID,
    audience: "organization" as "organization" | "private" | "public",
    revision: oldRevision,
    organization: org,
  };
  const writing = context.mocks.deferred<void>(),
    save = context.mocks.deferred<void>(),
    reading = context.mocks.deferred<void>(),
    refresh = context.mocks.deferred<void>();
  context.mocks.api(sharedThreadVisibilityContract.get, async ({ respond }) => {
    if (current.audience === "private") {
      reading.resolve();
      await refresh.promise;
    }
    return respond(200, current);
  });
  context.mocks.api(
    sharedThreadVisibilityContract.update,
    async ({ body, respond }) => {
      if (body.audience === "private") {
        writing.resolve();
        await save.promise;
      }
      current = {
        ...current,
        audience: body.audience,
        revision: crypto.randomUUID(),
      };
      return respond(200, current);
    },
  );
  await visit(true);
  const dialog = await share();
  const w = within(dialog);
  const orgOption = await findFastControl("radio", /Receipts team/, dialog);
  expect(orgOption).toHaveAttribute("aria-checked", "true");
  click(await findFastControl("button", "Copy link", dialog));
  await waitFor(() => {
    return expect(clip.writes.at(-1)).toBe(url);
  });
  const priv = await findFastControl("radio", /Only me/, dialog),
    pub = await findFastControl("radio", /Anyone with the link/, dialog);
  click(priv);
  await writing.promise;
  const group = w.getByRole("radiogroup");
  expect(group).toHaveAttribute("aria-busy", "true");
  for (const option of [priv, pub, orgOption]) {
    expect(option).toBeEnabled();
    expect(option).toHaveAttribute("aria-checked", "false");
  }
  click(pub);
  save.resolve();
  await reading.promise;
  expect(orgOption).toBeInTheDocument();
  expect(group).toHaveAttribute("aria-busy", "true");
  expect(w.queryByText(/loading permissions/i)).toBeNull();
  refresh.resolve();
  await waitFor(() => {
    return expect(pub).toHaveAttribute("aria-checked", "true");
  });
  expect(group).not.toHaveAttribute("aria-busy", "true");
});
