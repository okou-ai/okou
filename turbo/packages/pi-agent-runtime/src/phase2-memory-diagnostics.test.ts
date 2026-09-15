import { describe, expect, it } from "vitest";
import fixtures from "../../../../fixtures/pi-memory-phase2-terminal.json";
import {
  Phase2OutputInvalidError,
  phase2DiagnosticForError,
  sanitizePiMemoryPhase2Diagnostic,
} from "./phase2-memory-diagnostics";
import {
  PiMemoryPhase2EngineError,
  type PiMemoryPhase2FailureClass,
} from "./phase2-memory-types";

const counts = {
  candidateCount: 0,
  fileCount: 0,
  totalBytes: 0,
};

const FIXTURE_ERROR_CLASSES: Readonly<
  Record<string, PiMemoryPhase2FailureClass>
> = {
  aborted: "aborted",
  agent_output_invalid: "agent_output_invalid",
  model_failed: "model_failed",
  session_failed: "session_failed",
};

function fixtureErrorClass(name: string): PiMemoryPhase2FailureClass {
  const errorClass = FIXTURE_ERROR_CLASSES[name];
  if (!errorClass) {
    throw new Error("Unknown Pi memory Phase 2 fixture error class");
  }
  return errorClass;
}

describe("Pi Phase 2 terminal diagnostic boundary", () => {
  it.each(fixtures)(
    "serializes the cross-language $name fixture",
    (fixture) => {
      const error = new PiMemoryPhase2EngineError(
        fixtureErrorClass(fixture.errorClass),
        counts,
        fixture.diagnostic
          ? sanitizePiMemoryPhase2Diagnostic(fixture.diagnostic)
          : undefined,
      );
      error.message = "PRIVATE_MESSAGE_SENTINEL";
      error.stack = "PRIVATE_STACK_SENTINEL";
      error.cause = new Error("PRIVATE_CAUSE_SENTINEL");
      expect(error.terminalMessage()).toBe(fixture.stderr);
      expect(error.terminalMessage().length).toBeLessThan(512);
    },
  );

  it("drops unknown fields, maps unknown enums and bounds numeric fields", () => {
    const secret = "/private/memory/PRIVATE_SENTINEL?token=secret";
    const diagnostic = sanitizePiMemoryPhase2Diagnostic({
      stage: secret,
      reason: secret.repeat(1000),
      fileClass: secret,
      errno: secret,
      actual: Number.MAX_SAFE_INTEGER,
      limit: -1,
      path: secret,
      message: secret,
      stack: secret,
      cause: secret,
      prompt: secret,
      output: secret,
    });
    expect(diagnostic).toEqual({
      stage: "unknown",
      reason: "unknown",
      fileClass: "unknown",
      errno: "unknown",
      actual: 2147483647,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_SENTINEL");
    for (const invalid of [Infinity, NaN, -1, 1.5, "123", null]) {
      expect(
        sanitizePiMemoryPhase2Diagnostic({ actual: invalid, limit: invalid }),
      ).toEqual({ stage: "unknown", reason: "unknown" });
    }
    expect(
      sanitizePiMemoryPhase2Diagnostic({ actual: 0, limit: 65536 }),
    ).toEqual({ stage: "unknown", reason: "unknown", actual: 0, limit: 65536 });
  });

  it("revalidates untrusted diagnostic fields at terminal serialization", () => {
    const error = new PiMemoryPhase2EngineError("agent_output_invalid", counts);
    Object.defineProperty(error, "diagnostic", {
      value: {
        stage: "PRIVATE_STAGE_SENTINEL".repeat(1000),
        reason: "/private/path",
        fileClass: "PRIVATE_FILE_SENTINEL",
        errno: "PRIVATE_ERRNO_SENTINEL",
        actual: Number.MAX_SAFE_INTEGER,
        limit: Number.MAX_SAFE_INTEGER,
        toJSON() {
          throw new Error("PRIVATE_SERIALIZATION_SENTINEL");
        },
      },
    });
    const terminal = error.terminalMessage();
    expect(terminal).toBe(
      'Pi memory Phase 2 agent output was invalid. pi_memory_phase2={"stage":"unknown","reason":"unknown","fileClass":"unknown","errno":"unknown","actual":2147483647,"limit":2147483647}',
    );
    expect(terminal.length).toBeLessThan(512);
  });

  it("keeps unknown failures bounded and ignores throwing diagnostic accessors", () => {
    const secret = "PRIVATE_ERROR_SENTINEL";
    expect(
      phase2DiagnosticForError(
        Object.assign(new Error(secret), { code: secret }),
        "mounted_apply",
        "memory",
      ),
    ).toEqual({
      stage: "mounted_apply",
      reason: "unknown",
      fileClass: "memory",
      errno: "unknown",
    });
    expect(
      sanitizePiMemoryPhase2Diagnostic({
        get stage() {
          throw new Error(secret);
        },
      }),
    ).toEqual({ stage: "unknown", reason: "unknown" });
    expect(
      phase2DiagnosticForError(
        {
          get code() {
            throw new Error(secret);
          },
        },
        "mounted_apply",
      ),
    ).toEqual({
      stage: "mounted_apply",
      reason: "unknown",
      fileClass: "tree",
      errno: "unknown",
    });
    const failure = new Phase2OutputInvalidError("summary_header", {
      fileClass: "summary",
    });
    expect(phase2DiagnosticForError(failure, "output_validation")).toEqual({
      stage: "output_validation",
      reason: "summary_header",
      fileClass: "summary",
    });
  });
});
