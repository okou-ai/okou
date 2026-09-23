import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-test-delay.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-test-delay", rule, {
  valid: [
    // Importing non-delay from msw is fine
    {
      code: `import { http, HttpResponse } from "msw";`,
    },
    // Importing non-delay from signal-timers is fine
    {
      code: `import { timeout } from "signal-timers";`,
    },
    // createDeferredPromise is the recommended pattern
    {
      code: `import { createDeferredPromise } from "../../signals/utils.ts";`,
    },
    // vi.waitFor is fine
    {
      code: `await vi.waitFor(() => { expect(x).toBe(1); });`,
    },
    // The application clock is controlled without replacing timer scheduling.
    { code: `mockNow(boundary, context.signal);` },
    { code: `const elapsed = performance.now() - started; record(elapsed);` },
    { code: `expect(now() - started).toBe(3000);` },
    { code: `expect(Date.now()).toBe(boundary);` },
    { code: `import { setImmediate } from "node:timers/promises";` },
    {
      code: `const elapsed = Date.now() - started; function check() { const elapsed = 1; expect(elapsed).toBe(1); }`,
    },
    {
      code: `vi.useFakeTimers();`,
      filename:
        "/repo/apps/platform/src/lib/__tests__/visual-viewport-keyboard.test.ts",
      options: [
        {
          allowed: [
            {
              file: "src/lib/__tests__/visual-viewport-keyboard.test.ts",
              kinds: ["fakeTimer"],
              reason: "Migration tracked by issue 35594",
            },
          ],
        },
      ],
    },
  ],
  invalid: [
    // delay from signal-timers
    {
      code: `import { delay } from "signal-timers";`,
      errors: [{ messageId: "noDelayImport" }],
    },
    // delay from msw
    {
      code: `import { delay } from "msw";`,
      errors: [{ messageId: "noDelayImport" }],
    },
    // delay among other msw imports
    {
      code: `import { http, HttpResponse, delay } from "msw";`,
      errors: [{ messageId: "noDelayImport" }],
    },
    // setTimeout
    {
      code: `setTimeout(() => {}, 100);`,
      errors: [{ messageId: "noSetTimeout" }],
    },
    // setInterval
    {
      code: `setInterval(() => {}, 1000);`,
      errors: [{ messageId: "noSetInterval" }],
    },
    {
      code: `window.setTimeout(() => {}, 100);`,
      errors: [{ messageId: "noSetTimeout" }],
    },
    {
      code: `globalThis.setInterval(() => {}, 100);`,
      errors: [{ messageId: "noSetInterval" }],
    },
    {
      code: `import { setTimeout as delay } from "node:timers/promises";`,
      errors: [{ messageId: "noDelayImport" }],
    },
    {
      code: `import { setInterval as tick } from "node:timers";`,
      errors: [{ messageId: "noDelayImport" }],
    },
    {
      code: `import { delay as pause } from "signal-timers";`,
      errors: [{ messageId: "noDelayImport" }],
    },
    {
      code: `import { delay } from "msw";`,
      filename:
        "/repo/apps/platform/src/lib/__tests__/visual-viewport-keyboard.test.ts",
      options: [
        {
          allowed: [
            {
              file: "src/lib/__tests__/visual-viewport-keyboard.test.ts",
              kinds: ["fakeTimer"],
              reason: "Migration tracked by issue 35594",
            },
          ],
        },
      ],
      errors: [{ messageId: "noDelayImport" }],
    },
    ...[
      "useFakeTimers",
      "advanceTimersByTime",
      "advanceTimersByTimeAsync",
      "advanceTimersToNextTimer",
      "setSystemTime",
      "runAllTimers",
      "runOnlyPendingTimers",
      "runOnlyPendingTimersAsync",
    ].map((method) => ({
      code: `vi.${method}(3000);`,
      errors: [{ messageId: "noFakeTimer" as const }],
    })),
    {
      code: `expect(Date.now() - started).toBeGreaterThanOrEqual(3000);`,
      errors: [{ messageId: "noElapsedTime" }],
    },
    {
      code: `const elapsed = performance.now() - started; expect(elapsed).toBeLessThan(3000);`,
      errors: [{ messageId: "noElapsedTime" }],
    },
  ],
});
