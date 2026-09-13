import { describe, expect, it } from "vitest";

import {
  decideApiFirstTurnCommit,
  decideApiFirstTurnHistory,
  decideApiFirstTurnRecovery,
  decideApiFirstTurnTerminal,
  normalizedApiFirstTurnFailure,
  piApiFirstTurnError,
  PiApiFirstTurnModelFailureError,
} from "../pi-api-first-turn-policy";

// These conflicting snapshots specify precedence without simulating IO. Real
// lock races, effects and usage remain covered through chat-events BDD.
describe("Pi API-first transition precedence", () => {
  it.each([
    {
      rawSize: 16 * 1024 * 1024,
      encodedSize: 16 * 1024 * 1024,
      expected: "api",
    },
    { rawSize: 16 * 1024 * 1024 + 1, encodedSize: 1, expected: "sandbox" },
    { rawSize: 1, encodedSize: 16 * 1024 * 1024 + 1, expected: "sandbox" },
  ])(
    "selects history from raw=$rawSize encoded=$encodedSize",
    ({ rawSize, encodedSize, expected }) => {
      expect(decideApiFirstTurnHistory({ rawSize, encodedSize })).toBe(
        expected,
      );
    },
  );
  it.each([
    {
      pendingTools: false,
      activeInput: false,
      expected: { outcome: "complete" },
    },
    {
      pendingTools: true,
      activeInput: false,
      expected: {
        outcome: "transfer",
        mode: "pending-tool-continuation",
        reason: "pending_tool_continuation",
      },
    },
    {
      pendingTools: true,
      activeInput: true,
      expected: {
        outcome: "transfer",
        mode: "pending-tool-continuation",
        reason: "active_input_pending_tool",
      },
    },
    {
      pendingTools: false,
      activeInput: true,
      expected: {
        outcome: "transfer",
        mode: "settled-session-continuation",
        reason: "active_input_settled_session",
      },
    },
  ])(
    "commits pendingTools=$pendingTools activeInput=$activeInput",
    ({ pendingTools, activeInput, expected }) => {
      expect(
        decideApiFirstTurnCommit({ pendingTools, activeInput }),
      ).toStrictEqual(expected);
    },
  );

  const attempt = {
    activeInputBeforeProvider: false,
    ownershipStage: "pre-provider" as const,
    commitStarted: false,
    coordinationAborted: false,
    coordinationDeadlineAt: 55_000,
    observedAt: 45_000,
  };

  it("keeps a raw failure distinct from the private abort used to close its attempt", () => {
    const controller = new AbortController();
    const raw = new Error("invalid consumed usage");
    const failure = normalizedApiFirstTurnFailure(
      raw,
      controller.signal.aborted,
    );
    controller.abort(raw);
    expect(failure.code).toBe("PI_API_MODEL_FAILED");
    expect(decideApiFirstTurnRecovery({ ...attempt, failure })).toMatchObject({
      outcome: "arbitrate-terminal",
      suppressCompletionFailureLog: false,
    });
  });

  it.each([
    "PI_API_NATIVE_INPUT_REQUIRED",
    "PI_API_PREHEAT_FAILED",
    "PI_API_COMPACTION_PREFLIGHT_REQUIRED",
    "PI_API_RESOURCE_PREPARATION_FAILED",
  ] as const)(
    "recovers %s only before provider ownership and commit",
    (code) => {
      const failure = piApiFirstTurnError(code, "preparation failed");
      expect(decideApiFirstTurnRecovery({ ...attempt, failure })).toMatchObject(
        { outcome: "sandbox-first", reason: code },
      );
      for (const boundary of [
        { ownershipStage: "provider-may-have-started" as const },
        { commitStarted: true },
        { coordinationAborted: true },
      ]) {
        expect(
          decideApiFirstTurnRecovery({ ...attempt, ...boundary, failure })
            .outcome,
        ).toBe("arbitrate-terminal");
      }
    },
  );

  it.each([
    "PI_API_MODEL_CREDENTIAL_INVALID",
    "PI_API_RESOURCE_INVALID",
    "PI_H0_HASH_MISMATCH",
    "PI_H0_JSONL_INVALID",
    "PI_API_MODEL_OUTPUT_INCOMPLETE",
  ] as const)("does not grant H0 recovery for %s", (code) => {
    expect(
      decideApiFirstTurnRecovery({
        ...attempt,
        failure: piApiFirstTurnError(code, "invalid"),
      }).outcome,
    ).toBe("arbitrate-terminal");
  });

  it("retains active-input precedence while requiring the guarded transfer to validate delivery", () => {
    expect(
      decideApiFirstTurnRecovery({
        ...attempt,
        activeInputBeforeProvider: true,
        failure: piApiFirstTurnError(
          "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
          "deadline",
        ),
      }),
    ).toMatchObject({
      outcome: "sandbox-first",
      reason: "active_input",
      logAttemptTimeout: true,
    });
  });

  it.each(["pre-provider", "provider-may-have-started"] as const)(
    "recovers an API deadline at %s only before commit and the coordination cap",
    (ownershipStage) => {
      const facts = {
        ...attempt,
        ownershipStage,
        failure: piApiFirstTurnError(
          "PI_API_FIRST_TURN_DEADLINE_EXCEEDED",
          "deadline",
        ),
      };
      expect(decideApiFirstTurnRecovery(facts)).toMatchObject({
        outcome: "sandbox-first",
        reason: "api_attempt_timed_out",
        suppressCompletionFailureLog: true,
      });
      for (const boundary of [
        { commitStarted: true },
        { coordinationAborted: true },
        { observedAt: 55_000 },
      ]) {
        expect(
          decideApiFirstTurnRecovery({ ...facts, ...boundary }).outcome,
        ).toBe("arbitrate-terminal");
      }
    },
  );

  it.each([
    { status: 401, failureReason: undefined, outcome: "arbitrate-terminal" },
    { status: 403, failureReason: undefined, outcome: "arbitrate-terminal" },
    { status: 525, failureReason: undefined, outcome: "sandbox-first" },
    {
      status: 525,
      failureReason: "reconnect_required" as const,
      outcome: "arbitrate-terminal",
    },
    {
      status: 525,
      failureReason: "usage_limit" as const,
      outcome: "arbitrate-terminal",
    },
  ])(
    "arbitrates model status=$status reason=$failureReason",
    ({ status, failureReason, outcome }) => {
      const failure = new PiApiFirstTurnModelFailureError(
        { category: "http_error", httpStatus: status },
        failureReason,
      );
      expect(decideApiFirstTurnRecovery({ ...attempt, failure }).outcome).toBe(
        outcome,
      );
      for (const boundary of [
        { commitStarted: true },
        { coordinationAborted: true },
        { observedAt: 55_000 },
      ]) {
        expect(
          decideApiFirstTurnRecovery({ ...attempt, ...boundary, failure })
            .outcome,
        ).toBe("arbitrate-terminal");
      }
    },
  );

  it.each([
    { status: "cancelled", expected: "cancelled" },
    { status: "completed", expected: "already-terminal" },
    { status: "failed", expected: "already-terminal" },
    { status: undefined, expected: "already-terminal" },
    { status: "pending", expected: "fail" },
    { status: "running", expected: "fail" },
  ])(
    "preserves the durable terminal owner at $status",
    ({ status, expected }) => {
      expect(decideApiFirstTurnTerminal(status)).toBe(expected);
    },
  );
});
