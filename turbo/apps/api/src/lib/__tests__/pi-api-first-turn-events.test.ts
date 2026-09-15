import { readFileSync } from "node:fs";

import type { PiApiAssistantMessage } from "@okouai/pi-agent-runtime/api";
import { describe, expect, it } from "vitest";

import {
  piApiFirstTurnAssistantEvents,
  piApiFirstTurnResultEvent,
} from "../pi-api-first-turn-events";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../../fixtures/pi-public-events.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  readonly runId: string;
  readonly apiStartedAt: number;
  readonly apiObservedAt: number;
  readonly apiDurationMs: number;
  readonly cases: readonly {
    readonly name: string;
    readonly apiAssistant: PiApiAssistantMessage;
    readonly expectedMessages: readonly unknown[];
    readonly apiResult: string;
  }[];
};

// The route suites prove lifecycle and billing. This cross-language contract
// enters the actual producer before transport consumes its private envelope;
// neither raw sequence numbers nor private provenance are public route output.
describe("Pi API public projection fixtures", () => {
  it.each(fixture.cases)("projects $name", (example) => {
    const events = piApiFirstTurnAssistantEvents(
      fixture.runId,
      example.apiAssistant,
    );
    expect(events).toStrictEqual(
      example.expectedMessages.map((message, sequenceNumber) => {
        return { type: "assistant", sequenceNumber, message };
      }),
    );
    expect(
      piApiFirstTurnResultEvent(
        example.apiAssistant,
        fixture.apiStartedAt,
        events.length,
        fixture.apiObservedAt,
      ),
    ).toStrictEqual({
      type: "result",
      sequenceNumber: example.expectedMessages.length,
      subtype: "success",
      is_error: false,
      result: example.apiResult,
      duration_ms: fixture.apiDurationMs,
    });
  });
});
