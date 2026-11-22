import { screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { prepareSignedOutDocument } from "./entrypoint-fixture.ts";
const context = testContext();
test("preview-bypass-cookie-001 Opening the preview shell stores its one-hour credential with browser cookie protections", async () => {
  prepareSignedOutDocument(
    context,
    "https://pr-123-app.omby.ai/sign-in?x-vercel-protection-bypass=local%20preview",
  );
  const cookieWrites = vi.spyOn(document, "cookie", "set");
  const { startPlatformEntrypoint } =
    await import("../../lib/platform-entrypoint.ts");
  startPlatformEntrypoint();
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
  const preview = cookieWrites.mock.calls
    .map(([value]) => {
      return value;
    })
    .find((value) => {
      return value.startsWith("x-vercel-protection-bypass=");
    });
  expect(preview?.split(/;\s*/u).toSorted()).toStrictEqual(
    [
      "x-vercel-protection-bypass=local%20preview",
      "Path=/",
      "Max-Age=3600",
      "SameSite=Lax",
      "Secure",
    ].toSorted(),
  );
});
