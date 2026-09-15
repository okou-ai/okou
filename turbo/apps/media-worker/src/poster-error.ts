/**
 * 4xx codes describe the input itself, so re-rendering the same source cannot
 * change them. 5xx codes are worth another attempt.
 */
export const POSTER_ERROR_STATUS = {
  unsupported_media: 422,
  invalid_media: 422,
  decode_failed: 422,
  render_failed: 500,
  timeout: 504,
} as const;

type PosterErrorCode = keyof typeof POSTER_ERROR_STATUS;

export class PosterError extends Error {
  constructor(readonly code: PosterErrorCode) {
    super(code);
    this.name = "PosterError";
  }
}
