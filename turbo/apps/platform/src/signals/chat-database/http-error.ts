export class ChatDatabaseHttpError extends Error {
  constructor(readonly status: number) {
    super(`Chat database request failed with status ${status}`);
    this.name = "ChatDatabaseHttpError";
  }
}
