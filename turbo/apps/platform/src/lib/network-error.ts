export function isNetworkRequestError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "TypeError" &&
    (error.message === "Failed to fetch" ||
      error.message === "Load failed" ||
      error.message.startsWith("NetworkError"))
  );
}
