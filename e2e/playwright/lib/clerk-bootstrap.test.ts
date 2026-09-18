import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { chromium, expect, type Route } from "@playwright/test";

import { signInWithClerkEmailCode } from "./auth";
import { signInRunnerWithDiagnostics } from "./runner-sign-in";

const APP_URL = "https://clerk-bootstrap-fixture.test";
const CORE_URL = `${APP_URL}/clerk.browser.js`;

// Run the actual document bootstrap in Chromium so script fetch/error events
// and dynamically inserted retries follow browser semantics. Only the external
// Clerk SDK/UI is substituted; deployed auth-v1 tests cover the real sign-in UI.
async function fixture(
  context: TestContext,
  core: (route: Route) => Promise<void>,
) {
  const source = await readFile(
    new URL("../../../turbo/apps/platform/index.html", import.meta.url),
    "utf8",
  );
  const coreTag = source.match(
    /<script\s+id="okou-clerk-core-script"[\s\S]*?<\/script>/u,
  )?.[0];
  const bootstrapTag = source.match(
    /<script data-okou-clerk-bootstrap="">[\s\S]*?<\/script>/u,
  )?.[0];
  assert.ok(coreTag && bootstrapTag, "Expected the production Clerk bootstrap");
  const html = `<!doctype html><head>${coreTag}${bootstrapTag}</head><body>
    <p role="status">Loading</p>
    <script>
      window.__okouClerkBootstrap.runtime.then(async ({ loaded }) => {
        await loaded;
        document.querySelector('[role="status"]').textContent = 'Ready';
      }).catch(error => {
        document.querySelector('[role="status"]').textContent = error.message;
      });
    </script>
  </body>`
    .replaceAll("__OKOU_CLERK_BROWSER_SCRIPT_URL__", CORE_URL)
    .replaceAll("__OKOU_CLERK_UI_SCRIPT_URL__", `${APP_URL}/clerk-ui.js`)
    .replaceAll("__OKOU_CLERK_UI_VERSION__", "fixture")
    .replaceAll("%VITE_CLERK_PUBLISHABLE_KEY_PREVIEW%", "pk_test_fixture");
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  const coreRequests: string[] = [];
  await page.route(`${APP_URL}/**`, async (route) => {
    const url = route.request().url();
    if (url.startsWith(CORE_URL)) {
      coreRequests.push(url);
      await core(route);
    } else if (url === `${APP_URL}/clerk-ui.js`) {
      await route.fulfill({
        contentType: "text/javascript",
        body: "window.__okouClerkUI = { ClerkUI: function () {}, version: 'fixture' };",
      });
    } else {
      await route.fulfill({ contentType: "text/html", body: html });
    }
  });
  return { page, coreRequests };
}

const CLERK_FIXTURE = `
  const script = document.currentScript;
  if (script.dataset.clerkPublishableKey !== 'pk_test_fixture' ||
      !script.hasAttribute('data-clerk-js-script') ||
      script.crossOrigin !== 'anonymous') {
    throw new Error('Clerk loader attributes were not preserved');
  }
  let initialized = false;
  window.Clerk = {
    loaded: false,
    publishableKey: 'pk_test_fixture',
    organization: { id: 'org_fixture' },
    client: { signIn: { firstFactorVerification: {
      strategy: 'email_code', status: 'unverified'
    } } },
    on() {},
    async load({ ui }) {
      if (initialized) throw new Error('Clerk initialized twice');
      initialized = true;
      await ui.ClerkUI;
      this.loaded = true;
      const form = document.createElement('div');
      form.innerHTML = '<label>Email address <input type="email"></label><button>Continue</button>';
      form.querySelector('button').onclick = () => {
        form.innerHTML = '<input aria-label="Enter verification code">';
        form.querySelector('input').oninput = event => {
          if (event.target.value !== '424242') return;
          this.session = { getToken: async () => 'fixture-token' };
          history.replaceState(null, '', '/completed');
          form.innerHTML = '<h1>Signed in</h1>';
        };
      };
      document.body.appendChild(form);
    },
  };
`;

for (const failures of [0, 1, 2]) {
  test(`email-code sign-in succeeds after ${failures} core resource failures`, async (context) => {
    let attempts = 0;
    const { page, coreRequests } = await fixture(context, async (route) => {
      if (attempts++ < failures) {
        await route.abort("connectionreset");
      } else {
        await route.fulfill({
          contentType: "text/javascript",
          body: CLERK_FIXTURE,
        });
      }
    });

    const token = await signInWithClerkEmailCode(
      page,
      "fixture+clerk_test@example.com",
      APP_URL,
      { activeOrganizationId: "org_fixture" },
    );

    assert.equal(token, "fixture-token");
    await expect(
      page.getByRole("heading", { name: "Signed in" }),
    ).toBeVisible();
    assert.deepEqual(coreRequests, Array<string>(failures + 1).fill(CORE_URL));
  });
}

test(
  "exhausted core retries fail promptly and retain sanitized runner evidence",
  { timeout: 15_000 },
  async (context) => {
    const { page, coreRequests } = await fixture(context, (route) =>
      route.abort("connectionreset"),
    );
    const directory = await mkdtemp(join(tmpdir(), "clerk-bootstrap-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const diagnosticPath = join(directory, "sign-in.json");

    await assert.rejects(
      () =>
        signInRunnerWithDiagnostics(
          page,
          "email-secret+clerk_test@example.com",
          APP_URL,
          { activeOrganizationId: "org_fixture", diagnosticPath },
        ),
      /Clerk core bootstrap failed before email-code sign-in/u,
    );

    await expect(page.getByRole("status")).toHaveText(
      "Clerk core resource is unavailable",
    );
    assert.deepEqual(coreRequests, [CORE_URL, CORE_URL, CORE_URL]);
    const report = await readFile(diagnosticPath, "utf8");
    assert.equal(
      [...report.matchAll(/"failureCode": "net::ERR_CONNECTION_RESET"/gu)]
        .length,
      3,
    );
    assert.match(report, /"clerk": "absent"/u);
    assert.doesNotMatch(report, /email-secret|fixture-token/u);
  },
);

for (const scenario of [
  {
    name: "invalid exports",
    body: "window.Clerk = {};",
    error: "Clerk core script exposed no valid runtime",
  },
  {
    name: "synchronous initialization failure",
    body: "window.Clerk = { on() {}, load() { throw new Error('Initialization failed'); } };",
    error: "Initialization failed",
  },
  {
    name: "asynchronous initialization failure",
    body: "window.Clerk = { on() {}, load() { return Promise.reject(new Error('Initialization failed')); } };",
    error: "Initialization failed",
  },
]) {
  test(`core ${scenario.name} remains a terminal failure`, async (context) => {
    const { page, coreRequests } = await fixture(context, (route) =>
      route.fulfill({ contentType: "text/javascript", body: scenario.body }),
    );

    await page.goto(`${APP_URL}/sign-in`, { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("status")).toHaveText(scenario.error);
    assert.deepEqual(coreRequests, [CORE_URL]);
  });
}
