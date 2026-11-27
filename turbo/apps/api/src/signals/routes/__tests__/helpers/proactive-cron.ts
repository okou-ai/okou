import {
  cronCleanupSandboxesContract,
  cronProactiveContract,
} from "@okouai/api-contracts/contracts/cron";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { cronCleanupSandboxesRoutes } from "../../cron-cleanup-sandboxes";
import { cronProactiveRoutes } from "../../cron-proactive";
import type { ApiTestUser } from "./api-bdd";
import { createRunReadsApi } from "./api-bdd-run-reads";

export function createProactiveCronApi(context: TestContext) {
  const app = setupApp({
    context,
    routes: [...cronProactiveRoutes, ...cronCleanupSandboxesRoutes],
  });
  const headers = { authorization: "Bearer test-cron-secret" };
  return {
    async dispatch() {
      const result = await accept(
        app(cronProactiveContract).dispatch({ headers }),
        [200],
      );
      await accept(
        app(cronCleanupSandboxesContract).cleanup({ headers }),
        [200],
      );
      await flushWaitUntilForTest();
      return result.body;
    },
    async latestRun(actor: ApiTestUser, title: string) {
      const logs = await createRunReadsApi(context).requestListLogs(
        actor,
        { triggerSource: "proactive" },
        [200],
      );
      const run = logs.body.data.find((entry) => {
        return entry.prompt === title || entry.prompt.includes(`# ${title}\n`);
      });
      if (!run) {
        throw new Error(
          `Expected a scheduled ${title} Run, received: ${logs.body.data
            .map(({ prompt }) => {
              return prompt.slice(0, 60);
            })
            .join(", ")}`,
        );
      }
      return run.id;
    },
  };
}
