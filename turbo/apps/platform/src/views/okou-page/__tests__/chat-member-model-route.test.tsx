import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { accountModels } from "./chat-account-model-fixture.ts";
import {
  composerModelTrigger,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { buildProvider } from "./chat-model-builders.ts";
import { openModelPanel } from "./chat-model-panel-test-helpers.ts";

const context = testContext();

test("chat-member-model-route-003 the current Max and Fast settings show both effort and usage guidance", async () => {
  accountModels(
    context,
    ["gpt-5.6-sol"],
    "gpt-5.6-sol",
    { "gpt-5.6-sol": { effort: "max" } },
    "priority",
  );
  await setupPage({ context, path: "/" });
  const ui = within(await openModelPanel("GPT 5.6 Sol, Max, Fast"));
  expect(ui.getByRole("slider")).toHaveAttribute("aria-valuetext", "Max");
  expect(ui.getByRole("switch", { name: "Fast mode" })).toBeChecked();
  for (const label of [
    "Lower usage",
    "Higher usage",
    "2.5× subscription usage",
  ]) {
    expect(ui.getByText(label)).toBeInTheDocument();
  }
});

test.each([
  ["004", false],
  ["005", true],
] as const)(
  "chat-member-model-route-%s Codex reconnect addresses the account now attached to this model",
  async (_id, switchAccount) => {
    const sol = "gpt-5.6-sol";
    const { codex, rows } = accountModels(context, [sol], sol);
    const next = buildProvider({
      ...codex,
      id: "ae000000-0000-4000-a000-000000076002",
    });
    let current = codex;
    function updateCatalog() {
      context.mocks.data.personalModelProviders([
        {
          ...current,
          needsReconnect: true,
          lastRefreshErrorCode: "refresh_token_expired",
        },
      ]);
      context.mocks.data.availableRunModels(
        rows.map((row) => {
          return {
            ...row,
            modelProviderId: current.id,
            memberEffective: {
              ...row.memberEffective,
              availability: "reconnect_required",
            },
          };
        }),
      );
    }
    if (!switchAccount) {
      updateCatalog();
    }
    const target = context.mocks.deferred<unknown>();
    const code = switchAccount ? "NEXT-3424" : "C342-4000";
    context.mocks.api(codexDeviceAuthContract.start, ({ body, respond }) => {
      target.resolve(body);
      return respond(200, {
        sessionToken: "local-fixture",
        type: "codex",
        status: "pending",
        scope: "personal",
        browserUrl: "https://login.example.test/device",
        verificationCode: code,
        expiresIn: 600,
        interval: 5,
      });
    });
    await setupPage({ context, path: "/" });
    const editor = await findComposerEditor();
    if (switchAccount) {
      await composerModelTrigger("GPT 5.6 Sol");
      current = next;
      updateCatalog();
    }
    const text = switchAccount
      ? "Preserve this draft during reconnect"
      : "Do not send until reconnected.";
    await fill(editor, text);
    if (switchAccount) {
      context.mocks.ably.trigger("runModelsChanged", {});
    }
    const configure = await findFastControl("button", "Configure model");
    await expect(findFastControl("button", "Send")).resolves.toBeDisabled();
    click(configure);
    await screen.findByText(code);
    await expect(target.promise).resolves.toStrictEqual({
      scope: "personal",
      mode: "reconnect",
      modelProviderId: current.id,
    });
    expect(editor).toHaveTextContent(text);
  },
);
