import type { BrowserClerk } from "@clerk/shared/types";
import type { SharedDatabaseIdentity } from "../shared-database/data-key.ts";
import { createDeferredPromise, waitForToken } from "./utils.ts";

interface ClerkTokenSession {
  getToken(options?: { readonly skipCache?: boolean }): Promise<string | null>;
}

interface ClerkTokenResources {
  readonly session?: ClerkTokenSession | null;
}

interface ClerkTokenSource {
  readonly session: ClerkTokenSession | null | undefined;
  addListener(
    listener: (resources: ClerkTokenResources) => void,
    options?: { readonly skipInitialEmit?: boolean },
  ): () => void;
}

type SettledClerkSession = Exclude<ClerkTokenSource["session"], undefined>;

export function waitForClerkSession(
  clerk: ClerkTokenSource,
  signal: AbortSignal,
): Promise<SettledClerkSession> {
  signal.throwIfAborted();

  if (clerk.session !== undefined) {
    return Promise.resolve(clerk.session);
  }

  const deferred = createDeferredPromise<SettledClerkSession>(signal);
  const resolveIfSettled = (session: ClerkTokenSource["session"]): void => {
    if (session === undefined) {
      return;
    }
    signal.removeEventListener("abort", unsubscribe);
    unsubscribe();
    deferred.resolve(session);
  };
  const unsubscribe = clerk.addListener(
    ({ session }) => {
      resolveIfSettled(session);
    },
    { skipInitialEmit: true },
  );
  signal.addEventListener("abort", unsubscribe, { once: true });

  // Close the race between the initial read and listener registration.
  resolveIfSettled(clerk.session);

  return deferred.promise;
}

export async function readClerkToken(
  clerk: ClerkTokenSource,
  signal?: AbortSignal,
  options: { readonly skipCache?: true } = {},
): Promise<string | null> {
  if (!signal) {
    const session = clerk.session;
    if (!session) {
      return null;
    }
    return await session.getToken(
      options.skipCache ? { skipCache: true } : undefined,
    );
  }

  const session = await waitForClerkSession(clerk, signal);
  signal.throwIfAborted();
  if (session === null) {
    return null;
  }
  return await waitForToken(
    session.getToken(options.skipCache ? { skipCache: true } : undefined),
    signal,
  );
}

export async function readClerkMemberToken(
  clerk: BrowserClerk,
  member: SharedDatabaseIdentity,
  signal: AbortSignal,
): Promise<string> {
  const memberSession = async () => {
    await waitForClerkSession(clerk, signal);
    signal.throwIfAborted();
    const { session, user } = clerk;
    if (session?.user?.id !== member.userId || user?.id !== member.userId) {
      // A live port must report a provider failure so another tab can answer.
      throw new Error(
        "The current Clerk session does not match the shared database member",
      );
    }
    return session;
  };
  const session = await memberSession();
  // Clerk scopes this token explicitly, even while its active organization is changing.
  const token = await waitForToken(
    session.getToken({ organizationId: member.orgId }),
    signal,
  );
  await memberSession();
  if (!token) {
    throw new Error("Clerk token is unavailable");
  }
  return token;
}
