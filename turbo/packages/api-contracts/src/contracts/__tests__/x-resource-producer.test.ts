import { describe, expect, it } from "vitest";

import { webhookUsageEventContract } from "../webhooks";
import fixtures from "./fixtures/x-resource-observations.json";

describe("X producer shared wire fixtures", () => {
  it.each(fixtures.cases)(
    "preserves $name through the API contract",
    (fixture) => {
      for (const payload of fixture.expectedPayloads) {
        expect(
          webhookUsageEventContract.send.body.parse(payload),
        ).toStrictEqual(payload);
      }
    },
  );
});
