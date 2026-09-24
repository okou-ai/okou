export class BrowserInputRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextAction: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BrowserInputRequestError";
  }
}

export function withBrowserInputFieldPosition(
  error: unknown,
  position: number,
): BrowserInputRequestError {
  if (!(error instanceof BrowserInputRequestError)) {
    throw error;
  }
  return new BrowserInputRequestError(
    error.code,
    `--field ${position}: ${error.message}`,
    error.nextAction,
    error.retryable,
  );
}
