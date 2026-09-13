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
  readonly routerPush: InlineClerkRouter;
  readonly routerReplace: InlineClerkRouter;
  readonly signInUrl: string;
}

interface InlineClerkRouterMetadata {
  readonly windowNavigate: (to: URL | string) => void;
}

type InlineClerkRouter = (
  url: string,
  metadata: InlineClerkRouterMetadata,
) => unknown;

interface InlineBootstrapConfiguration {
  readonly loadOptions: InlineBootstrapLoadOptions;
}

interface InlineBootstrapWindow {
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
  return { bootstrap, bootstrapWindow, appendedScripts };
}

const PAGE_HOSTNAMES = [
  "app.okou.ai",
  "okou.ai",
  "team.app.okou.ai",
  "app.okou.ai.evil.example",
  "pr-30199-app.omby.ai",
];

test("The inline Clerk bootstrap uses the current page sign-in URL", () => {
  for (const hostname of PAGE_HOSTNAMES) {
    const { bootstrap } = runInlineBootstrap(hostname);

    expect({
      hostname,
      pageSignInUrl: bootstrap.loadOptions.signInUrl,
    }).toStrictEqual({
      hostname,
      pageSignInUrl: `https://${hostname}/sign-in`,
    });
  }
});

test("The inline bootstrap loads installed UI only for auth routes", () => {
  for (const pathname of [
    "/agents",
    "/v1/sign-in",
    "/v1/sign-up",
    "/v1/sign-invader",
  ]) {
    expect(
      runInlineBootstrap("app.okou.ai", pathname).appendedScripts,
    ).toStrictEqual([]);
  }
  for (const pathname of [
    "/sign-in",
    "/sign-in/tasks/choose-organization",
    "/sign-up",
    "/sign-up/tasks/choose-organization",
  ]) {
    const { appendedScripts } = runInlineBootstrap("app.okou.ai", pathname);
    expect(appendedScripts).toHaveLength(1);
    expect(appendedScripts[0]?.src).toBe("__OKOU_CLERK_UI_SCRIPT_URL__");
  }
});

test("The inline Clerk router delegates only while an app route owns it", () => {
  const { bootstrap, bootstrapWindow } = runInlineBootstrap("app.okou.ai");
  const windowNavigations: string[] = [];
  const metadata = {
    windowNavigate(to: URL | string) {
      windowNavigations.push(to.toString());
    },
  };

  bootstrap.loadOptions.routerPush("/sign-in/factor-one", metadata);
  expect(windowNavigations).toStrictEqual(["/sign-in/factor-one"]);

  const routeNavigations: string[] = [];
  bootstrapWindow.__okouClerkRouter = {
    push(url) {
      routeNavigations.push(`push:${url}`);
    },
    replace(url) {
      routeNavigations.push(`replace:${url}`);
    },
  };
  bootstrap.loadOptions.routerPush("/sign-in/factor-one", metadata);
  bootstrap.loadOptions.routerReplace("/sign-in", metadata);

  expect(routeNavigations).toStrictEqual([
    "push:/sign-in/factor-one",
    "replace:/sign-in",
  ]);
  expect(windowNavigations).toStrictEqual(["/sign-in/factor-one"]);
});
