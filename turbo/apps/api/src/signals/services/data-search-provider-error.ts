export class DataSearchProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 402 | 403 | 404 | 409 | 422 | 429 | 502 | 503 = 502,
  ) {
    super(message);
    this.name = "DataSearchProviderError";
  }
}
