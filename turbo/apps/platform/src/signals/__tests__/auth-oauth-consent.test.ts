import { expect, test } from "vitest";
import { readOAuthConsentContinuation } from "../auth.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

test.each([
  ["local development", "https://www.vm7.ai:8443"],
  ["production", "https://app.okou.ai"],
])("Accept the exact %s auth origin for OAuth consent", (_, authOrigin) => {
  context.mocks.browser.url(`${authOrigin}/sign-in`);
  const consentUrl = `${authOrigin}/oauth-consent?client_id=https%3A%2F%2Fclient.example%2Fmetadata.json&code_challenge=synthetic-challenge&code_challenge_method=S256&prompt=consent`;

  expect(
    readOAuthConsentContinuation(
      `?redirect_url=${encodeURIComponent(consentUrl)}`,
      "",
    )?.toString(),
  ).toBe(consentUrl);
});
