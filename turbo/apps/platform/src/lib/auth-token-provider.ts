export type AuthTokenProvider = (
  signal?: AbortSignal,
) => Promise<string | null>;
