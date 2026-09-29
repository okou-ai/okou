import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { signalCheckAwait } from "../rules/signal-check-await";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("signal-check-await", signalCheckAwait, {
  valid: [
    {
      code: `command(async ({ set }, orgId: string, signal?: AbortSignal) => {
        const row = await readRow(orgId);
        signal?.throwIfAborted();
        return row;
      })`,
    },
    {
      code: `command(async ({ set }, orgId: string, signal: AbortSignal) => {
        const row = await readRow(orgId);
        signal.throwIfAborted();
        return row;
      })`,
    },
  ],
  invalid: [
    {
      code: `command(async ({ set }, orgId: string, signal?: AbortSignal) => {
        const row = await readRow(orgId);
        return row;
      })`,
      errors: [{ messageId: "missingSignalCheck" }],
    },
    {
      code: `command(async ({ set }, orgId: string, signal?: AbortSignal) => {
        const row = await readRow(orgId);
        anotherSignal?.throwIfAborted();
        return row;
      })`,
      errors: [{ messageId: "missingSignalCheck" }],
    },
    {
      code: `command(async ({ set }, orgId: string, signal?: AbortSignal) => {
        const row = await readRow(orgId);
        signal?.toString();
        return row;
      })`,
      errors: [{ messageId: "missingSignalCheck" }],
    },
  ],
});
