import { act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { tabByText } from "./chat-composer-test-helpers.ts";

test("A stale workspace preference response never replaces the current owner's notice", async () => {
  mockTemplateChat();
  const firstRequest = context.mocks.deferred<void>();
  const firstSettled = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let first = true;
  context.mocks.api(paidToolsContract.get, async ({ respond, withSignal }) => {
    if (first) {
      first = false;
      firstRequest.resolve();
      try {
        await withSignal(release.promise);
        return respond(200, { disabledTools: ["image-generation"] });
      } finally {
        firstSettled.resolve();
      }
    }
    return respond(200, { disabledTools: ["video-generation"] });
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.PaidToolControls]: true,
      [FeatureSwitchKey.SettingsToolsTab]: true,
      [FeatureSwitchKey.ChatPreference]: true,
      [FeatureSwitchKey.ComposerSlashTemplatePanel]: true,
    },
  });
  const dialog = await openTemplatePicker(
    userEvent.setup({ delay: null }),
    "Illustration",
  );
  await firstRequest.promise;
  act(() => {
    context.mocks.clerk().organization({
      activeOrg: { id: "org_second", name: "Second workspace" },
      memberships: [{ id: "org_second" }],
    });
    context.mocks.clerk().stateChanged();
  });

  click(tabByText("Video"));
  await within(dialog).findByText("Video generation is off for you");
  release.resolve();
  await firstSettled.promise;
  expect(
    within(dialog).queryByText("Image generation is off for you"),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).getByText("Video generation is off for you"),
  ).toBeInTheDocument();
});
