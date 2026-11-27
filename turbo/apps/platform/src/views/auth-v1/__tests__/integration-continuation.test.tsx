import { cleanup, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const host = "app.okou.ai";
const member = () => {
  return {
    user: { id: "member-erin", fullName: "Erin Ward" },
    organization: { activeOrg: null, memberships: [] },
  };
};

const signedTelegram =
  "bot=official&tgUser=682913&tgUserName=erin_case&tgDisplayName=Erin+Ward&ts=1795000000&sig=" +
  "19".repeat(32) +
  "&context=mobile&context=setup";
const destinations = [
  [
    "001",
    "email message",
    "/settings/email?message=letter-421&expires=1900000000&signature=" +
      "c9".repeat(32),
  ],
  [
    "002",
    "signed phone",
    "/settings/agentphone?handle=%2B15555550194&agent=phone-71&ts=1795000000&sig=" +
      "3e".repeat(32) +
      "&context=device&channel=imessage&context=callback",
  ],
  [
    "003",
    "Slack OAuth",
    "/connectors/slack/callback?integration=slack&code=reply-87&state=state-828&team=T602",
  ],
  [
    "004",
    "Teams OAuth",
    "/connectors/microsoft-365/callback?integration=teams&code=reply-19&state=state-813&tenantId=tenant-31",
  ],
  [
    "005",
    "GitHub installation",
    "/connectors/github/callback?integration=github&state=state-451&installation_id=58231&setup_action=install",
  ],
  [
    "006",
    "Slack settings",
    "/settings/slack?context=install&u=U19K&c=C428&w=T602&t=1795000000.728&context=team",
  ],
  ["007", "Telegram identity", "/settings/telegram?" + signedTelegram],
  ["008", "mixed-case Telegram", "/SETTINGS/Telegram/?" + signedTelegram],
  [
    "010",
    "pending Discord",
    "/settings/discord?status=pending&guild_id=892541296347801054",
  ],
  [
    "011",
    "Discord install",
    "/settings/discord/install?status=connected&guild_id=782541296347801056",
  ],
  [
    "012",
    "Teams conversation",
    "/settings/teams?conversationId=conv-903&context=team&activityId=mention-17&channelId=channel-4&tenantId=tenant-74&threadId=reply-116&teamsUserId=person-31&orgId=workspace-61&teamsAadObjectId=directory-34&context=channel",
  ],
] as const;

async function followOrganizationRedirect(entry: string) {
  // No form renders in the document that initiates a full-page redirect.
  await startPage({
    context,
    path: entry,
    host,
    auth: member(),
  });
  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in/tasks/choose-organization");
  });
  const next = new URL(window.location.href);
  expect(next.origin).toBe("https://" + host);
  cleanup();
  await setupPage({
    context: createTestRuntime(context),
    path: next.pathname + next.search + next.hash,
    host: next.host,
    auth: member(),
  });
  const form = await screen.findByTestId("clerk-sign-in");
  expect(form).toBeVisible();
  return { next, form };
}
test.each(destinations)(
  "integration-continuation-%s The chooser carries %s through to the hosted sign-in form",
  async (_id, _name, destination) => {
    const entry = destination + "#workspace-access";
    const expected = new URL(entry, "https://" + host).href;
    const { next, form } = await followOrganizationRedirect(entry);
    expect(next.searchParams.get("redirect_url")).toBe(expected);
    expect(form).toHaveAttribute("data-clerk-force-redirect-url", expected);
  },
);
test("integration-continuation-031 Works opens organization selection without a return destination", async () => {
  const { next, form } = await followOrganizationRedirect("/works");
  expect(next.searchParams.has("redirect_url")).toBeFalsy();
  expect(form).toHaveAttribute(
    "data-clerk-force-redirect-url",
    "https://" + host,
  );
});

test("integration-continuation-039 An external Telegram-looking return leaves the chooser pointing home", async () => {
  const query = new URLSearchParams({
    redirect_url: "https://external.example/settings/telegram?context=mobile",
  });
  await setupPage({
    context,
    host,
    auth: null,
    path: "/sign-in/tasks/choose-organization?" + query,
  });
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toHaveAttribute(
    "data-clerk-force-redirect-url",
    "https://app.okou.ai",
  );
});
