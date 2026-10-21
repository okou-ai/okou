export class SocialDataProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 422 | 429 | 502 | 503 = 502,
  ) {
    super(message);
    this.name = "SocialDataProviderError";
  }
}
