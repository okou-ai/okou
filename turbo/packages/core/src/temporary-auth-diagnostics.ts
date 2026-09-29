// Temporary investigation for #36177. Remove the diagnostic emitters after
// 2026-10-29 10:30 Asia/Shanghai; both runtimes stop emitting at this deadline.
export const AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT = Date.parse(
  "2026-10-29T02:30:00Z",
);

/** Owns expiry and best-effort delivery for these temporary Axiom records. */
export function recordTemporaryAuthFailure(
  timestamp: number,
  emit: () => void,
): void {
  if (timestamp >= AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT) {
    return;
  }
  try {
    emit();
  } catch {
    // Diagnostic transport failures must never replace the auth response.
    return;
  }
}
