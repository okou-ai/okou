/* eslint-disable no-restricted-syntax -- #34243 intentionally exercises deferred infrastructure states that production endpoints cannot yet create. This split preserves the existing service-suite exception while allowing Vitest file-level parallelism. */
import { describe, test } from "vitest";

import { registerLifecycleTests } from "./helpers/pi-deferred-sandbox-suite";

describe("durable deferred Pi consumer through actual PostgreSQL and Runner routes", () => {
  registerLifecycleTests(test);
});
