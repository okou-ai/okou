import type { TestContext } from "../../signals/__tests__/test-helpers.ts";
import { installMockedClerkBootstrap } from "../../__tests__/mock-auth.ts";
import {
  createBootstrapRoot,
  installBootstrapSkeleton,
} from "../../test/bootstrap-skeleton.ts";
export function prepareSignedOutDocument(context: TestContext, url: string) {
  context.mocks.browser.url(url);
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36",
  );
  const sdk = context.mocks.clerk();
  sdk.user(null, null);
  sdk.sessionSignedOut(true);
  installMockedClerkBootstrap(context.signal);
  const posthog = context.mocks.posthog();
  const sentry = context.mocks.sentry();
  const root = createBootstrapRoot();
  installBootstrapSkeleton(context.signal);
  document.body.append(root);
  context.signal.addEventListener(
    "abort",
    () => {
      return root.remove();
    },
    { once: true },
  );
  return { posthog, sentry, root };
}
