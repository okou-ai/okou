import type { ZodType } from "zod";

import { ProviderResponseError } from "./provider-error";

export async function parseProviderTokenResponse<T>(
  response: Response,
  schema: ZodType<T>,
  failureMessage: string,
): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ProviderResponseError(failureMessage);
    }
    throw error;
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderResponseError(failureMessage);
  }
  return parsed.data;
}
