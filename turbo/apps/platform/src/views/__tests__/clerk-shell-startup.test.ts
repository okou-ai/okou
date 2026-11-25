import type { ClerkOptions } from "@clerk/shared/types";
import { expect, test, vi } from "vitest";
import html from "../../../index.html?raw";
import { testContext } from "../../signals/__tests__/test-helpers.ts";

const context = testContext();

function openShell(host: string) {
  const page = new DOMParser().parseFromString(
    html
      .replaceAll("%VITE_CLERK_PUBLISHABLE_KEY_PROD%", "fixture-production")
      .replaceAll("%VITE_CLERK_PUBLISHABLE_KEY_PREVIEW%", "fixture-preview"),
    "text/html",
  );
  const core = page.querySelector<HTMLScriptElement>("#okou-clerk-core-script");
  const source = page.querySelector(
    "script[data-okou-clerk-bootstrap]",
  )?.textContent;
  if (!core || !source) {
    throw new Error("Missing Clerk bootstrap in deployed document");
  }
  const loadGate = context.mocks.deferred<void>();
  const provider = {
    on: vi.fn<() => void>(),
    load: vi.fn<(options: ClerkOptions) => Promise<void>>((_options) => {
      return loadGate.promise;
    }),
  };
  const shell: Pick<Window, "__okouClerkBootstrap" | "__okouClerkRouter"> & {
    Clerk: typeof provider;
  } = { Clerk: provider };
  const run = new Function("location", "document", "window", source) as (
    location: URL,
    document: Document,
    window: typeof shell,
  ) => void;
  run(new URL("/agents", "https://" + host), page, shell);
  const runtime = shell.__okouClerkBootstrap?.runtime;
  if (!runtime) {
    throw new Error("Shell did not publish the identity runtime");
  }
  return { core, shell, runtime, loadGate, provider };
}

test("clerk-bootstrap-001 Agents requests the production identity resource with same-origin account URLs", async () => {
  const { core, runtime, provider, loadGate } = openShell("app.okou.ai");
  expect(core.dataset.clerkPublishableKey).toBe("fixture-production");
  core.dispatchEvent(new Event("load"));
  await runtime;
  expect(provider.load).toHaveBeenCalledWith(
    expect.objectContaining({
      signInUrl: "https://app.okou.ai/sign-in",
      signUpUrl: "https://app.okou.ai/sign-up",
      afterSignOutUrl: "https://app.okou.ai/sign-in",
    }),
  );
  loadGate.resolve();
});

test("clerk-bootstrap-004 Shell publishes the same pending load that belongs to the loaded SDK", async () => {
  const { core, runtime, provider, loadGate } = openShell("app.okou.ai");
  expect(provider.load).not.toHaveBeenCalled();
  core.dispatchEvent(new Event("load"));
  const identity = await runtime;
  expect(identity.clerk).toBe(provider);
  expect(identity.loaded).toBe(loadGate.promise);
  expect(provider.load.mock.calls[0]?.[0]).toMatchObject({
    afterSignOutUrl: "https://app.okou.ai/sign-in",
    signInUrl: "https://app.okou.ai/sign-in",
    signUpUrl: "https://app.okou.ai/sign-up",
  });
  loadGate.resolve();
  await identity.loaded;
});

test("clerk-bootstrap-003 Early Clerk navigation sends sign-in to the browser", async () => {
  const { core, runtime, provider, loadGate, shell } = openShell("app.okou.ai");
  core.dispatchEvent(new Event("load"));
  await runtime;
  const browserNavigate = vi.fn<(url: string | URL) => void>();
  await provider.load.mock.calls[0]?.[0].routerPush?.("/sign-in", {
    windowNavigate: browserNavigate,
  });
  expect(browserNavigate).toHaveBeenCalledWith("/sign-in");
  expect(shell.__okouClerkRouter).toBeUndefined();
  loadGate.resolve();
});

test("clerk-bootstrap-005 Each shell uses its own host for sign-in", async () => {
  for (const host of [
    "app.okou.ai",
    "okou.ai",
    "team.app.okou.ai",
    "app.okou.ai.evil.example",
    "pr-30199-app.omby.ai",
  ]) {
    const { core, runtime, provider, loadGate } = openShell(host);
    core.dispatchEvent(new Event("load"));
    await runtime;
    expect(provider.load.mock.calls[0]?.[0].signInUrl).toBe(
      "https://" + host + "/sign-in",
    );
    loadGate.resolve();
  }
});
