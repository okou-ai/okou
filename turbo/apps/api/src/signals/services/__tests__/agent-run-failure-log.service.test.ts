/* eslint-disable no-restricted-syntax -- #35468 covers an internal, content-free observability projection that has no public response surface. Keep the exception at this logger-owned contract suite. */
import { describe, it } from "vitest";

import { registerAgentRunFailureLogTests } from "./helpers/agent-run-failure-log-suite";

describe("agent failure logging contracts", () => {
  registerAgentRunFailureLogTests(it);
});
