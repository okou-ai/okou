import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  mockTeams,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const queryName = "x-vercel-protection-bypass";
test.each([
  [
    "preview-bypass-cookie-004",
    "https://pr-22085-api.vm6.ai/api/chat/events",
    "preview secret",
  ],
  [
    "preview-bypass-cookie-005",
    "https://pr-22085-api.vm6.ai.evil.example/api/chat/events",
    null,
  ],
  [
    "preview-bypass-cookie-006",
    "https://pr-22086-api.vm6.ai/api/chat/events",
    null,
  ],
  [
    "preview-bypass-cookie-007",
    "https://pr-22085-www.vm6.ai/connector/success?x-vercel-protection-bypass=stale-fixture",
    null,
  ],
] as const)(
  "%s Opening the Teams authorization link sends only the credential belonging to its destination",
  async (_id, target, expected) => {
    const popup = context.mocks.browser.open();
    mockTeams(context, { connectUrl: target });
    await setupPage({
      context,
      host: "pr-22085-app.omby.ai",
      path: "/settings/teams?" + queryName + "=preview%20secret",
    });
    const authorize = await findAction("button", "Authorize Microsoft Teams");
    expect(popup.calls).toHaveLength(0);
    click(authorize);
    const opened = popup.calls.at(-1);
    expect(opened?.target).toBe("_blank");
    const actual = new URL(opened?.url ?? "");
    const destination = new URL(target);
    expect([actual.origin, actual.pathname]).toStrictEqual([
      destination.origin,
      destination.pathname,
    ]);
    expect(actual.searchParams.get(queryName)).toBe(expected);
  },
);
