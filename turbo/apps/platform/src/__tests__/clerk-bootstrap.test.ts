import { expect, test } from "vitest";

import indexHtml from "../../index.html?raw";
import { setupPage } from "./page-helper.ts";
import { mockedClerkLoad } from "./mock-auth.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();

test("Okou production uses its own authentication URLs", async () => {
  const clerk = context.mocks.clerk();

  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/agents",
  });

  expect(clerk.resourceRequests).toStrictEqual([
    { publishableKey: "test_production_key" },
  ]);
  expect(clerk.loads).toContainEqual({
    afterSignOutUrl: "https://app.okou.ai/sign-in",
    signInUrl: "https://app.okou.ai/sign-in",
    signUpUrl: "https://app.okou.ai/sign-up",
  });
});

test("App-started Clerk keeps browser navigation until a route owns it", async () => {
  context.mocks.clerk();
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/agents",
  });
  expect(window.__okouClerkRouter).toBeUndefined();

  const loadOptions = mockedClerkLoad.mock.lastCall?.[0];
  expect(loadOptions?.routerPush).toBeTypeOf("function");
  expect(loadOptions?.routerReplace).toBeTypeOf("function");
  const windowNavigations: string[] = [];
  await loadOptions?.routerPush?.("/sign-in", {
    windowNavigate(to) {
      windowNavigations.push(to.toString());
    },
  });

  expect(windowNavigations).toStrictEqual(["/sign-in"]);
});

const BOOTSTRAP_SCRIPT_SELECTOR = "[data-okou-clerk-bootstrap]";

interface InlineBootstrapLoadOptions {
  readonly afterSignOutUrl: string;
  readonly routerPush: InlineClerkRouter;
  readonly routerReplace: InlineClerkRouter;
  readonly signInUrl: string;
  readonly signUpUrl: string;
}

interface InlineClerkRouterMetadata {
  readonly windowNavigate: (to: URL | string) => void;
}

type InlineClerkRouter = (
  url: string,
  metadata: InlineClerkRouterMetadata,
) => unknown;

interface InlineClerk {
  readonly load: (options: InlineBootstrapLoadOptions) => Promise<void>;
  readonly on: () => void;
}

interface InlineBootstrapConfiguration {
  readonly runtime: Promise<{
    readonly clerk: InlineClerk;
    readonly loaded: Promise<void>;
  }>;
}

interface InlineBootstrapWindow {
  Clerk?: InlineClerk;
  __okouClerkBootstrap?: InlineBootstrapConfiguration;
  __okouClerkRouter?: {
    readonly push: InlineClerkRouter;
    readonly replace: InlineClerkRouter;
  };
}

interface InlineBootstrapScript {
  src?: string;
  dataset: Record<string, string>;
  onerror: (() => void) | null;
  onload: (() => void) | null;
  remove: () => void;
}

type InlineBootstrap = (
  window: InlineBootstrapWindow,
  document: {
    getElementById: (id: string) => InlineBootstrapScript;
    createElement: (tag: string) => InlineBootstrapScript;
    head: { appendChild: (script: InlineBootstrapScript) => void };
  },
  location: { hostname: string; origin: string; pathname: string },
) => void;

function inlineBootstrapSource(): string {
  const page = new DOMParser().parseFromString(indexHtml, "text/html");
  const source = page.querySelector(BOOTSTRAP_SCRIPT_SELECTOR)?.textContent;
  if (!source) {
    throw new Error("index.html no longer contains the Clerk bootstrap script");
  }
  return source;
}

/** Runs the bootstrap the deployed page runs. */
function runInlineBootstrap(hostname: string, pathname = "/sign-in") {
  const runBootstrap = new Function(
    "window",
    "document",
    "location",
    inlineBootstrapSource(),
  ) as InlineBootstrap;
  const script: InlineBootstrapScript = {
    dataset: {},
    onerror: null,
    onload: null,
    remove: () => {
      return;
    },
  };
  const bootstrapWindow: InlineBootstrapWindow = {};
  const appendedScripts: InlineBootstrapScript[] = [];
  runBootstrap(
    bootstrapWindow,
    {
      getElementById: () => {
        return script;
      },
      createElement: () => ({ ...script }),
      head: {
        appendChild: (uiScript) => {
          appendedScripts.push(uiScript);
        },
      },
    },
    { hostname, origin: `https://${hostname}`, pathname },
  );
  const bootstrap = bootstrapWindow.__okouClerkBootstrap;
  if (!bootstrap) {
    throw new Error("The inline Clerk bootstrap published no configuration");
  }
  return { bootstrap, bootstrapWindow, appendedScripts, script };
}

async function startInlineClerkRuntime(hostname: string, pathname = "/agents") {
  const page = runInlineBootstrap(hostname, pathname);
  const loaded = Promise.resolve();
  let loadOptions: InlineBootstrapLoadOptions | undefined;
  const clerk: InlineClerk = {
    load(options) {
      loadOptions = options;
      return loaded;
    },
    on() {
      return;
    },
  };
  page.bootstrapWindow.Clerk = clerk;
  page.script.onload?.();

  const runtime = await page.bootstrap.runtime;
  if (!loadOptions) {
    throw new Error(
      "The inline Clerk bootstrap did not initialize the runtime",
    );
  }
  return { ...page, clerk, loaded, loadOptions, runtime };
}

const PAGE_HOSTNAMES = [
  "app.okou.ai",
  "okou.ai",
  "team.app.okou.ai",
  "app.okou.ai.evil.example",
  "pr-30199-app.omby.ai",
];

test("The inline bootstrap owns the Clerk runtime", async () => {
  const { clerk, loaded, loadOptions, runtime } =
    await startInlineClerkRuntime("app.okou.ai");

  expect(runtime).toStrictEqual({ clerk, loaded });
  expect(loadOptions).toMatchObject({
    afterSignOutUrl: "https://app.okou.ai/sign-in",
    signInUrl: "https://app.okou.ai/sign-in",
    signUpUrl: "https://app.okou.ai/sign-up",
  });
});

test("The inline Clerk bootstrap uses the current page sign-in URL", async () => {
  for (const hostname of PAGE_HOSTNAMES) {
    const { loadOptions } = await startInlineClerkRuntime(hostname);

    expect({
      hostname,
      pageSignInUrl: loadOptions.signInUrl,
    }).toStrictEqual({
      hostname,
      pageSignInUrl: `https://${hostname}/sign-in`,
    });
  }
});
