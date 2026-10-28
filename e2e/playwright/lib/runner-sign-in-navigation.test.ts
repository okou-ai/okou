import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";

import { chromium, errors, expect } from "@playwright/test";

import { startRunnerNetworkDiagnostics } from "./runner-network-diagnostics";
import {
  navigateToRunnerSignIn,
  type RunnerSignInNavigationOptions,
} from "./runner-sign-in-navigation";

async function fixture(context: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH,
  });
  context.after(() => browser.close());
  const page = await browser.newPage();
  const url = `http://127.0.0.1:${address.port}/sign-in`;
  const started = performance.now();
  const observe = () =>
    startRunnerNetworkDiagnostics(
      page,
      () => Math.round(performance.now() - started),
      { appOrigin: new URL(url).origin, expected: { kind: "missing" } },
    );
  let network = await observe();
  context.after(() => network.dispose());
  return {
    page,
    url,
    get network() {
      return network;
    },
    navigate: (
      options: RunnerSignInNavigationOptions,
      beforeRetry: (attempt: number) => Promise<void> = async () => {},
    ) =>
      navigateToRunnerSignIn(
        page,
        url,
        options,
        beforeRetry,
        () => network.transferActivity(),
        async () => {
          await network.dispose();
          network = await observe();
        },
      ),
  };
}

test("initial sign-in navigation succeeds without replacing a healthy page", async (context) => {
  let documents = 0;
  const { page, navigate } = await fixture(context, (request, response) => {
    if (request.url !== "/sign-in") {
      response.writeHead(404).end();
      return;
    }
    documents++;
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><h1>Sign in</h1>");
  });
  await navigate({ idleTimeoutMs: 100, timeoutMs: 2_000 }, async () =>
    assert.fail("A healthy page must not be replaced"),
  );
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  assert.equal(documents, 1);
});

test("persistent idle navigation stops after two replacements", async (context) => {
  let documents = 0;
  const { navigate } = await fixture(context, () => {
    documents++;
  });
  await assert.rejects(
    navigate({ idleTimeoutMs: 100, timeoutMs: 1_500 }),
    errors.TimeoutError,
  );
  assert.equal(documents, 3);
});

test("the shared navigation deadline can expire before a retry is eligible", async (context) => {
  let documents = 0;
  const { navigate } = await fixture(context, () => {
    documents++;
  });
  await assert.rejects(
    navigate({ idleTimeoutMs: 1_000, timeoutMs: 100 }, async () =>
      assert.fail("The navigation budget has expired"),
    ),
    errors.TimeoutError,
  );
  assert.equal(documents, 1);
});

test("unavailable transfer observation keeps the bounded navigation without retries", async (context) => {
  let documents = 0;
  const { navigate, network } = await fixture(context, () => {
    documents++;
  });
  await network.dispose();
  await assert.rejects(
    navigate({ idleTimeoutMs: 100, timeoutMs: 400 }, async () =>
      assert.fail("Incomplete observation cannot establish inactivity"),
    ),
    errors.TimeoutError,
  );
  assert.equal(documents, 1);
});

test("a document making regular progress can outlast the idle interval", async (context) => {
  let documents = 0;
  const { page, navigate } = await fixture(context, (request, response) => {
    if (request.url !== "/sign-in") {
      response.writeHead(404).end();
      return;
    }
    documents++;
    response.writeHead(200, { "content-type": "text/html" });
    response.write("<!doctype html><body>");
    let chunks = 0;
    // Model an actual streaming peer. Every tick emits body data; this is the
    // transfer under test, not a sleep used to synchronize a test assertion.
    const stream = setInterval(() => {
      response.write(`<p>${"progress ".repeat(1_024)}</p>`);
      if (++chunks === 8) {
        clearInterval(stream);
        response.end("<h1>Complete</h1>");
      }
    }, 75);
    response.on("close", () => clearInterval(stream));
  });
  await navigate({ idleTimeoutMs: 300, timeoutMs: 3_000 }, async () =>
    assert.fail("Regular body progress must keep the navigation"),
  );
  await expect(page.getByRole("heading", { name: "Complete" })).toBeVisible();
  assert.equal(documents, 1);
});

test("navigation completed during evidence capture is not replaced", async (context) => {
  let documents = 0;
  let finish: (() => void) | undefined;
  const { page, navigate } = await fixture(context, (request, response) => {
    if (request.url !== "/sign-in") {
      response.writeHead(404).end();
      return;
    }
    documents++;
    finish = () =>
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<!doctype html><h1>Late completion</h1>");
  });
  await navigate({ idleTimeoutMs: 100, timeoutMs: 3_000 }, async () => {
    assert.ok(finish);
    // The original document has not committed, so about:blank's state is not
    // evidence of completion. Await the real document before the load state.
    const committed = page.waitForEvent("framenavigated", {
      predicate: (frame) => frame === page.mainFrame(),
    });
    finish();
    await committed;
    await page.waitForLoadState("domcontentloaded");
  });
  await expect(
    page.getByRole("heading", { name: "Late completion" }),
  ).toBeVisible();
  assert.equal(documents, 1);
});

test("an explicit navigation network failure is not retried", async (context) => {
  let documents = 0;
  const { navigate } = await fixture(context, (request) => {
    documents++;
    request.socket.destroy();
  });
  await assert.rejects(
    navigate({ idleTimeoutMs: 100, timeoutMs: 800 }, async () =>
      assert.fail("An explicit network failure is not a stall"),
    ),
    /net::ERR_/u,
  );
  // Chromium itself may repeat a failed GET; the helper must not navigate again.
  assert.ok(documents > 0);
});

test("an HTTP failure is not hidden by another idle script", async (context) => {
  let documents = 0;
  const { navigate } = await fixture(context, (request, response) => {
    if (request.url === "/sign-in") {
      documents++;
      response.writeHead(200, { "content-type": "text/html" }).end(`
        <!doctype html>
        <script defer src="/okou-app/assets/broken.js"></script>
        <script defer src="/okou-app/assets/pending.js"></script>`);
    } else if (request.url === "/okou-app/assets/broken.js") {
      response.writeHead(503).end();
    } else if (request.url !== "/okou-app/assets/pending.js") {
      response.writeHead(404).end();
    }
  });
  await assert.rejects(
    navigate({ idleTimeoutMs: 100, timeoutMs: 800 }, async () =>
      assert.fail("An HTTP failure is not an idle-transfer retry"),
    ),
    errors.TimeoutError,
  );
  assert.equal(documents, 1);
});
