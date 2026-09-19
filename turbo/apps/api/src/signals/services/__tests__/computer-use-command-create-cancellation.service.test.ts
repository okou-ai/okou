import { createStore } from "ccstate";
import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { withMockNowForTest } from "../../../lib/time";
import { withComputerUseCommandCreateBarrierFixture } from "../../../test-fixtures/computer-use-command-create-erasure";
import { createBddApi } from "../../routes/__tests__/helpers/api-bdd";
import { createComputerUseBddApi } from "../../routes/__tests__/helpers/api-bdd-computer-use";
import { settleIncludingAbort } from "../../utils";
import { createComputerUseCommand$ } from "../computer-use.service";

const context = testContext();
const bdd = createBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-19T01:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;
const CAPABILITIES = ["apps.list"] as const;

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

describe("Computer Use command creation cancellation", () => {
  it(
    "rejects a pre-aborted production command before BEGIN and preserves a public retry",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = bdd.user();
      const orgId = actor.orgId;
      if (!orgId) {
        throw new Error(
          "Computer Use command creation requires an organization",
        );
      }
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "R21 cancellation guard",
        supportedCapabilities: CAPABILITIES,
      });
      let retryCommandId: string | undefined;

      await withComputerUseCommandCreateBarrierFixture(
        {
          orgId,
          stopAt: "insert",
          work: async (barrier) => {
            const preAbortedController = new AbortController();
            preAbortedController.abort(
              new DOMException("pre-transaction abort", "AbortError"),
            );

            await expect(
              createStore().set(
                createComputerUseCommand$,
                {
                  orgId,
                  userId: actor.userId,
                  kind: "apps.list",
                  payload: {},
                  timeoutMs: 11_001,
                },
                preAbortedController.signal,
              ),
            ).rejects.toStrictEqual(
              expect.objectContaining({
                name: "AbortError",
                message: "pre-transaction abort",
              }),
            );
            expect(barrier.startedTransactionCount()).toBe(0);

            const retryController = new AbortController();
            const retry = computerUse.requestCreateComputerUseReadCommand(
              actor,
              { kind: "apps.list", timeoutMs: 11_001 },
              [200],
              retryController.signal,
            );
            const retrySettled = settleIncludingAbort(retry);
            const entrySettled = settleIncludingAbort(barrier.entered);
            const first = await Promise.race([
              entrySettled.then((settled) => {
                return { kind: "entry" as const, settled };
              }),
              retrySettled.then((settled) => {
                return { kind: "retry" as const, settled };
              }),
            ]);
            if (first.kind === "retry") {
              retryController.abort(
                new DOMException("retry did not enter", "AbortError"),
              );
              barrier.release();
              if (!first.settled.ok) {
                throw first.settled.error;
              }
              throw new Error(
                "Computer Use retry completed before barrier entry",
              );
            }
            if (!first.settled.ok) {
              retryController.abort(
                new DOMException("barrier entry failed", "AbortError"),
              );
              barrier.release();
              await retrySettled;
              throw first.settled.error;
            }

            barrier.release();
            const outcome = await retrySettled;
            retryController.abort(
              new DOMException("retry observation complete", "AbortError"),
            );
            if (!outcome.ok) {
              throw outcome.error;
            }
            expect(first.settled.value.rowCount).toBe(1);
            expect(outcome.value.status).toBe(200);
            if (!("commandId" in outcome.value.body)) {
              throw new Error("Expected the retry command id");
            }
            retryCommandId = outcome.value.body.commandId;
          },
        },
        context.signal,
      );

      if (!retryCommandId) {
        throw new Error("Expected one retry command");
      }
      await expect(
        computerUse.claimNextComputerUseCommand(host.hostToken, CAPABILITIES),
      ).resolves.toMatchObject({
        status: "command",
        command: { id: retryCommandId, status: "running" },
      });
    },
  );
});
