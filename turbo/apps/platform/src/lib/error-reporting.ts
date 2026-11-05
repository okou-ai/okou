const reportingOwner = Symbol("error-reporting-owner");

/** The handling boundary owns reporting even when it recovers without a report. */
export function claimErrorReporting(error: Error): void {
  Object.defineProperty(error, reportingOwner, { value: true });
}

export function hasErrorReportOwner(error: unknown): boolean {
  const visited = new Set<Error>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (reportingOwner in current && current[reportingOwner] === true) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
