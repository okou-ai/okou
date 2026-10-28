import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";

import { chromium, errors, expect } from "@playwright/test";

import { navigateToRunnerSignIn } from "./runner-sign-in-navigation";
import { startRunnerNetworkDiagnostics } from "./runner-network-diagnostics";

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
  const network = await startRunnerNetworkDiagnostics(
    page,
    () => Math.round(performance.now() - started),
    { appOrigin: new URL(url).origin, expected: { kind: "missing" } },
  );
  context.after(() => network.dispose());
  return {
    page,
    url,
    responseHeaders: () => network.responseHeaders(),
    network,
  };
}

test("initial sign-in navigation succeeds without replacing a healthy page", async (context) => {
  let documents = 0;
  const { page, url, responseHeaders } = await fixture(
    context,
    (request, response) => {
      if (request.url !== "/sign-in") {
        response.writeHead(404).end();
        return;
      }
      documents++;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><h1>Sign in</h1>");
    },
  );
  await navigateToRunnerSignIn(
    page,
    url,
    { noResponseTimeoutMs: 100, timeoutMs: 2_000 },
    async () => assert.fail("A healthy page must not be replaced"),
    responseHeaders,
  );
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  assert.equal(documents, 1);
});

test("persistent no-response navigation stops after two replacements", async (context) => {
  let documents = 0;
  const { page, url, responseHeaders } = await fixture(context, () => {
    documents++;
  });
  await assert.rejects(
    navigateToRunnerSignIn(
      page,
      url,
      { noResponseTimeoutMs: 100, timeoutMs: 800 },
      async () => {},
      responseHeaders,
    ),
    errors.TimeoutError,
  );
  assert.equal(documents, 3);
});

test("the shared navigation deadline can expire before a retry is eligible", async (context) => {
  let documents = 0;
  const { page, url, responseHeaders } = await fixture(context, () => {
    documents++;
  });
  await assert.rejects(
    navigateToRunnerSignIn(
      page,
      url,
      { noResponseTimeoutMs: 1_000, timeoutMs: 100 },
      async () => assert.fail("The navigation budget has expired"),
      responseHeaders,
    ),
    errors.TimeoutError,
  );
  assert.equal(documents, 1);
});

test("unavailable response observation keeps the bounded navigation without retries", async (context) => {
  let documents = 0;
  const { page, url, responseHeaders, network } = await fixture(context, () => {
    documents++;
  });
  await network.dispose();
  await assert.rejects(
    navigateToRunnerSignIn(
      page,
      url,
      { noResponseTimeoutMs: 100, timeoutMs: 400 },
      async () =>
        assert.fail("Incomplete observation cannot establish a stall"),
      responseHeaders,
    ),
    errors.TimeoutError,
  );
  assert.equal(documents, 1);
});

for (const resource of ["document", "script"]) {
  test(`a responded ${resource} body stall is not a no-response retry`, async (context) => {
    let documents = 0;
    const { page, url, responseHeaders, network } = await fixture(
      context,
      (request, response) => {
        if (request.url === "/sign-in") {
          documents++;
          response.writeHead(200, { "content-type": "text/html" });
          if (resource === "document") {
            response.flushHeaders();
          } else {
            response.end(
              '<!doctype html><script defer src="/okou-app/assets/entry.js"></script>',
            );
          }
        } else if (request.url === "/okou-app/assets/entry.js") {
          response.writeHead(200, {
            "content-type": "text/javascript",
            "x-content-type-options": "nosniff",
            "set-cookie": "private=header-secret",
          });
          response.flushHeaders();
        } else {
          response.writeHead(404).end();
        }
      },
    );
    await assert.rejects(
      navigateToRunnerSignIn(
        page,
        url,
        { noResponseTimeoutMs: 100, timeoutMs: 400 },
        async () => assert.fail("A response was already observed"),
        responseHeaders,
      ),
      errors.TimeoutError,
    );
    assert.equal(documents, 1);
    const report = network.freeze();
    assert.equal(report.kind, "observed");
    if (report.kind === "observed") {
      const transfer = report.requests.find(
        (request) => request.resourceType === resource,
      );
      assert.ok(transfer);
      assert.ok(
        report.responseHeaders.some(
          (headers) =>
            headers.requestId === transfer.requestId && headers.status === 200,
        ),
      );
    }
    assert.doesNotMatch(JSON.stringify(report), /header-secret|set-cookie/iu);
  });
}

test("an explicit navigation network failure is not retried", async (context) => {
  let documents = 0;
  const { page, url, responseHeaders } = await fixture(context, (request) => {
    documents++;
    request.socket.destroy();
  });
  await assert.rejects(
    navigateToRunnerSignIn(
      page,
      url,
      { noResponseTimeoutMs: 100, timeoutMs: 800 },
      async () => assert.fail("An explicit network failure is not a stall"),
      responseHeaders,
    ),
    /net::ERR_/u,
  );
  // Chromium may itself repeat a failed GET; the helper must not navigate again.
  assert.ok(documents > 0);
});

test("an HTTP failure is not hidden by another script without a response", async (context) => {
  let documents = 0;
  const { page, url, responseHeaders } = await fixture(
    context,
    (request, response) => {
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
    },
  );
  await assert.rejects(
    navigateToRunnerSignIn(
      page,
      url,
      { noResponseTimeoutMs: 100, timeoutMs: 800 },
      async () => assert.fail("An HTTP failure is not a no-response stall"),
      responseHeaders,
    ),
    errors.TimeoutError,
  );
  assert.equal(documents, 1);
});
