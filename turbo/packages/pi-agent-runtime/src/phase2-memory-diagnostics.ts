/** Content-free diagnostics carried by the existing terminal error string. */
const STAGES = [
  "workspace_stage",
  "session_create",
  "model_turn",
  "final_response",
  "output_validation",
  "mounted_apply",
  "commit",
  "unknown",
] as const;
const REASONS = [
  "unknown",
  "unexpected_error",
  "workspace_stage_failed",
  "session_create_failed",
  "model_turn_failed",
  "final_message_missing",
  "final_stop_error",
  "final_stop_length",
  "final_stop_tool_use",
  "final_stop_pending",
  "final_stop_aborted",
  "provider_result_missing",
  "heartbeat_stopped",
  "caller_disposed",
  "result_missing",
  "filesystem",
  "unsafe_path",
  "unsafe_tree",
  "file_size",
  "inventory_files",
  "inventory_paths",
  "inventory_bytes",
  "file_integrity",
  "base_mismatch",
  "final_identity",
  "immutable_changed",
  "required_artifact",
  "memory_invalid",
  "memory_bytes",
  "summary_encoding",
  "summary_header",
  "summary_bytes",
  "summary_tokens",
  "skill_path",
  "skill_encoding",
  "skill_file_bytes",
  "skill_files",
  "skill_bytes",
] as const;
const FILE_CLASSES = [
  "memory",
  "summary",
  "skill",
  "git",
  "immutable",
  "tree",
  "unknown",
] as const;
const ERRNOS = [
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EROFS",
  "ENOENT",
  "EIO",
  "EMFILE",
  "ENFILE",
  "EISDIR",
  "ENOTDIR",
  "ELOOP",
  "unknown",
] as const;
const MAX_COUNT = 2_147_483_647;

export interface PiMemoryPhase2Diagnostic {
  readonly stage: (typeof STAGES)[number];
  readonly reason: (typeof REASONS)[number];
  readonly fileClass?: (typeof FILE_CLASSES)[number];
  readonly errno?: (typeof ERRNOS)[number];
  readonly actual?: number;
  readonly limit?: number;
}

function allowed<T extends string>(
  values: readonly T[],
  value: unknown,
): T | undefined {
  return values.find((candidate) => {
    return candidate === value;
  });
}

function boundedCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_COUNT)
    : undefined;
}

/** Re-project at the log boundary; never serialize arbitrary properties or text. */
export function sanitizePiMemoryPhase2Diagnostic(
  value: unknown,
): PiMemoryPhase2Diagnostic {
  try {
    const fields =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const fileClass =
      fields.fileClass === undefined
        ? undefined
        : (allowed(FILE_CLASSES, fields.fileClass) ?? "unknown");
    const errno =
      fields.errno === undefined
        ? undefined
        : (allowed(ERRNOS, fields.errno) ?? "unknown");
    const actual = boundedCount(fields.actual);
    const limit = boundedCount(fields.limit);
    return Object.freeze({
      stage: allowed(STAGES, fields.stage) ?? "unknown",
      reason: allowed(REASONS, fields.reason) ?? "unknown",
      ...(fileClass === undefined ? {} : { fileClass }),
      ...(errno === undefined ? {} : { errno }),
      ...(actual === undefined ? {} : { actual }),
      ...(limit === undefined ? {} : { limit }),
    });
  } catch {
    // A hostile diagnostic accessor must not replace the primary failure.
    return Object.freeze({ stage: "unknown", reason: "unknown" });
  }
}

export function phase2FileClass(
  path: string,
): NonNullable<PiMemoryPhase2Diagnostic["fileClass"]> {
  if (path === "MEMORY.md") return "memory";
  if (path === "memory_summary.md") return "summary";
  if (path.startsWith("skills/")) return "skill";
  if (path === ".git" || path.startsWith(".git/")) return "git";
  return path === "" ? "tree" : "immutable";
}

export class Phase2OutputInvalidError extends Error {
  readonly diagnostic: PiMemoryPhase2Diagnostic;

  constructor(
    reason: PiMemoryPhase2Diagnostic["reason"] = "unknown",
    details: Omit<PiMemoryPhase2Diagnostic, "stage" | "reason"> = {},
    stage: PiMemoryPhase2Diagnostic["stage"] = "output_validation",
  ) {
    super("Pi memory Phase 2 agent output was invalid.");
    this.diagnostic = sanitizePiMemoryPhase2Diagnostic({
      ...details,
      stage,
      reason,
    });
  }
}

/**
 * Read only a data property: raw text and arbitrary getters stay outside this
 * best-effort diagnostic boundary.
 */
function phase2Errno(error: unknown): PiMemoryPhase2Diagnostic["errno"] {
  try {
    const value: unknown =
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "code")?.value
        : undefined;
    return allowed(ERRNOS, value);
  } catch {
    return undefined;
  }
}

/** Attribute a bounded lifecycle stage without inspecting failure content. */
export function phase2StageDiagnostic(
  stage: PiMemoryPhase2Diagnostic["stage"],
  reason: PiMemoryPhase2Diagnostic["reason"],
  error?: unknown,
): PiMemoryPhase2Diagnostic {
  const errno = error === undefined ? undefined : phase2Errno(error);
  return sanitizePiMemoryPhase2Diagnostic({
    stage,
    reason,
    ...(errno === undefined ? {} : { errno }),
  });
}

export function phase2DiagnosticForError(
  error: unknown,
  stage: PiMemoryPhase2Diagnostic["stage"],
  fileClass: PiMemoryPhase2Diagnostic["fileClass"] = "tree",
): PiMemoryPhase2Diagnostic {
  if (error instanceof Phase2OutputInvalidError) {
    return sanitizePiMemoryPhase2Diagnostic({ ...error.diagnostic, stage });
  }
  const errno = phase2Errno(error);
  return sanitizePiMemoryPhase2Diagnostic({
    stage,
    reason: errno && errno !== "unknown" ? "filesystem" : "unknown",
    fileClass,
    errno: errno ?? "unknown",
  });
}
