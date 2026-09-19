import { expect, test } from "vitest";
import { readOAuthConsentContinuation } from "../auth.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

test.each([
  ["local development", "https://app.vm7.ai:8443"],
  ["production", "https://app.okou.ai"],
])("Accept the exact %s app origin for OAuth consent", (_, appOrigin) => {
  context.mocks.browser.url(`${appOrigin}/sign-in`);
  const consentUrl = `${appOrigin}/oauth-consent?client_id=https%3A%2F%2Fclient.example%2Fmetadata.json&code_challenge=synthetic-challenge&code_challenge_method=S256&prompt=consent`;

  expect(
    readOAuthConsentContinuation(
      `?redirect_url=${encodeURIComponent(consentUrl)}`,
      "",
    )?.toString(),
  ).toBe(consentUrl);
});

test("Reject a consent continuation on the Marketing origin", () => {
  context.mocks.browser.url("https://app.vm7.ai:8443/sign-in");
  const consentUrl =
    "https://www.vm7.ai:8443/oauth-consent?client_id=https%3A%2F%2Fclient.example%2Fmetadata.json";

  expect(
    readOAuthConsentContinuation(
      `?redirect_url=${encodeURIComponent(consentUrl)}`,
      "",
    ),
  ).toBeNull();
});
