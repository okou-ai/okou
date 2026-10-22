import { createDeferredPromise, withCleanup } from "./utils.ts";

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

function waitForToken<T>(token: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const aborted = createDeferredPromise<never>(signal);
  // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
  return withCleanup(Promise.race([token, aborted.promise]), () => {
    if (!aborted.settled()) {
      aborted.reject(new DOMException("Token read settled", "AbortError"));
    }
  });
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
