import {
  isClerkResourceNotFound,
  type ClerkClient,
  type ClerkUser,
} from "./clerk";
import { settle } from "../utils";

/** Resolve one user without the list endpoint's unused count request. */
export async function findClerkUser(
  clerk: ClerkClient,
  userId: string,
  signal?: AbortSignal,
): Promise<ClerkUser | null> {
  const result = await settle(
    clerk.users.getUser(userId, undefined, signal),
    signal,
  );
  if (result.ok) {
    return result.value;
  }
  if (isClerkResourceNotFound(result.error)) {
    return null;
  }
  throw result.error;
}
