/** Shared request-validation error formatting for HTTP and transport adapters. */
export function requestValidationError(issue: {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}) {
  const path = issue.path.map(String).join(".");
  return {
    error: {
      code: "BAD_REQUEST" as const,
      message: path ? `${path}: ${issue.message}` : issue.message,
    },
  };
}
