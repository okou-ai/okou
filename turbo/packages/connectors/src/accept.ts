export class HttpStatusError extends Error {
  constructor(readonly response: Response) {
    super(`Unexpected upstream HTTP status: ${response.status}`);
    this.name = "HttpStatusError";
  }

  get status(): number {
    return this.response.status;
  }
}

/** Return a response the caller handles; propagate every other outcome. */
export async function accept(
  promise: Promise<Response>,
  statuses: readonly [number, ...number[]],
): Promise<Response> {
  const response = await promise;
  if (!statuses.includes(response.status)) {
    throw new HttpStatusError(response);
  }
  return response;
}
