import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noTestViMocks } from "../rules/no-test-vi-mocks.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-test-vi-mocks", noTestViMocks, {
  valid: [
    { code: "vi.resetModules();" },
    { code: "context.mocks.clerk.authenticateRequest.mockResolvedValue({});" },
    { code: "mocks.sentry.captureException.mockReset();" },
    { code: "const value = vi;" },
    {
      filename: "/api/src/__tests__/pglite-setup.ts",
      code: 'vi.mock("../lib/db", async () => ({}));',
    },
  ],
  invalid: [
    {
      filename: "/api/src/__tests__/pglite-setup.ts",
      code: 'vi.mock("../signals/services/model-selection.service", () => ({}));',
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      filename: "/api/src/signals/routes/__tests__/other.test.ts",
      code: 'vi.mock("../../../lib/db", () => ({}));',
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      filename: "/api/src/__tests__/pglite-setup.ts",
      code: 'vi.spyOn(console, "error");',
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      code: 'vi.mock("@clerk/backend", () => ({}));',
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      code: 'vi.spyOn(console, "error");',
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      code: 'vi.stubGlobal("fetch", mockFetch);',
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      code: "const mock = vi.fn();",
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      code: "const mocks = vi.hoisted(() => ({}));",
      errors: [{ messageId: "noTestViMock" }],
    },
    {
      code: 'import { vi as vitest } from "vitest"; vitest.mock("pkg");',
      errors: [{ messageId: "noTestViMock" }],
    },
  ],
});
