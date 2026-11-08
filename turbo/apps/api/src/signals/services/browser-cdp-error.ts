export class BrowserUseCdpCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
    this.name = "BrowserUseCdpCommandError";
  }
}
