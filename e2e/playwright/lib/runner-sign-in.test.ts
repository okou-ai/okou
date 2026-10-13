import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";

import { chromium, errors } from "@playwright/test";

import { signInRunnerWithDiagnostics } from "./runner-sign-in";

async function fixture(context: TestContext, handler: RequestListener) {
  const directory = await mkdtemp(join(tmpdir(), "runner-sign-in-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
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
  const appUrl = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH,
  });
  context.after(() => browser.close());
  const page = await browser.newPage();
  // The server deliberately withholds a document or script. This shorter
  // fixture-only deadline exercises failure without waiting 30 seconds.
  page.setDefaultNavigationTimeout(2_000);
  const diagnosticPath = join(directory, "sign-in", "runner.json");
  const signIn = () =>
    signInRunnerWithDiagnostics(
      page,
      "email-secret+clerk_test@example.com",
      appUrl,
      { activeOrganizationId: "org_fixture", diagnosticPath },
    );
  return { appUrl, page, directory, diagnosticPath, signIn };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function networkRequests(report: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(report);
  assert.ok(isRecord(value) && isRecord(value.network));
  assert.equal(value.network.kind, "observed");
  assert.ok(Array.isArray(value.network.requests));
  return value.network.requests.map((request: unknown) => {
    assert.ok(isRecord(request));
    return request;
  });
}

test("sign-in timeout retains an outstanding document before any commit", async (context) => {
  const { diagnosticPath, signIn } = await fixture(context, () => {});
  await assert.rejects(signIn, errors.TimeoutError);
  const report = await readFile(diagnosticPath, "utf8");
  assert.match(report, /"resourceType": "document"/u);
  assert.match(report, /"outcome": "pending"/u);
  assert.match(report, /"milestones": \[\]/u);
  assert.doesNotMatch(report, /"status":/u);
  assert.equal((await stat(diagnosticPath)).mode & 0o777, 0o600);
});

test("sign-in report identifies headers without observed body progress", async (context) => {
  const { diagnosticPath, signIn } = await fixture(
    context,
    (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "x-content-type-options": "nosniff",
        "cf-ray": "0123456789abcdef-SJC",
        "x-private": "header-secret",
      });
      response.flushHeaders();
    },
  );
  await assert.rejects(signIn, errors.TimeoutError);
  const report = await readFile(diagnosticPath, "utf8");
  const document = networkRequests(report).find(
    (request) => request.resourceType === "document",
  );
  assert.ok(document);
  assert.equal(document.status, 200);
  assert.equal(document.protocol, "http/1.1");
  assert.equal(document.cfRay, "0123456789abcdef-SJC");
  assert.equal(document.outcome, "pending");
  assert.equal(document.dataEvents, 0);
  assert.equal(document.decodedDataBytes, 0);
  assert.equal(document.encodedDataBytes, 0);
  assert.equal(document.firstDataMs, undefined);
  assert.equal(document.totalEncodedBytes, undefined);
  assert.doesNotMatch(report, /header-secret|x-private/iu);
});

test("sign-in report retains partial document progress before a stall", async (context) => {
  const { diagnosticPath, signIn } = await fixture(
    context,
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.write(
        `<!doctype html><html><body>${"body-secret".repeat(2_048)}`,
      );
    },
  );
  await assert.rejects(signIn, errors.TimeoutError);
  const report = await readFile(diagnosticPath, "utf8");
  const document = networkRequests(report).find(
    (request) => request.resourceType === "document",
  );
  assert.ok(document);
  assert.equal(document.status, 200);
  assert.equal(document.outcome, "pending");
  assert.ok(typeof document.dataEvents === "number" && document.dataEvents > 0);
  assert.ok(
    typeof document.decodedDataBytes === "number" &&
      document.decodedDataBytes > 0,
  );
  assert.ok(typeof document.firstDataMs === "number");
  assert.ok(
    typeof document.lastDataMs === "number" &&
      document.lastDataMs >= document.firstDataMs,
  );
  assert.equal(document.totalEncodedBytes, undefined);
  assert.doesNotMatch(report, /body-secret/u);
});

test("sign-in report separates a stalled deferred script from HTTP and network failures", async (context) => {
  const { page, appUrl, diagnosticPath, signIn } = await fixture(
    context,
    (request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.test").pathname;
      if (path === "/sign-in") {
        response
          .writeHead(302, {
            location: "/login?handshake=query-secret#fragment-secret",
            "cf-ray": "0123456789abcdef-SJC",
          })
          .end();
      } else if (path === "/login") {
        response
          .writeHead(200, {
            "content-type": "text/html",
            "content-encoding": "gzip",
            "set-cookie": "session=cookie-secret",
            "cf-ray": "fedcba9876543210-LHR",
          })
          .end(
            gzipSync(`
        <div id="app-bootstrap-skeleton">body-secret</div>
        <p>${"body-secret".repeat(1_024)}</p>
        <script>
          console.error('console-secret');
          fetch('/unavailable?token=fetch-secret');
          fetch('/disconnected?token=network-secret').catch(() => {});
          fetch('/post', {method: 'POST', body: 'post-secret'});
          throw new Error('error-secret');
        </script>
        <script defer src="/slow.js?token=script-secret"></script>`),
          );
      } else if (path === "/slow.js") {
        // Leave the deferred script outstanding so DOMContentLoaded cannot fire.
      } else if (path === "/disconnected") {
        request.socket.destroy();
      } else {
        response
          .writeHead(503, {
            "x-private": "header-secret",
            "cf-ray": "invalid-ray-secret",
          })
          .end("response-secret");
      }
    },
  );
  await page
    .context()
    .setExtraHTTPHeaders({ Authorization: "Bearer auth-secret" });
  await page
    .context()
    .addCookies([{ name: "bypass", value: "bypass-secret", url: appUrl }]);
  await assert.rejects(signIn, errors.TimeoutError);
  const report = await readFile(diagnosticPath, "utf8");
  assert.match(report, /"event": "document-committed"/u);
  assert.doesNotMatch(report, /"event": "domcontentloaded"/u);
  assert.match(
    report,
    /"url": "http:\/\/127\.0\.0\.1:\d+\/slow.js",\s*"resourceType": "script",\s*"startedMs": \d+,\s*"outcome": "pending"/u,
  );
  assert.match(report, /"status": 503/u);
  assert.match(report, /"outcome": "failed"/u);
  assert.match(report, /"failureCode": "net::ERR_/u);
  assert.match(report, /"outcome": "pending"/u);
  assert.match(report, /"clerk": "absent"/u);
  assert.match(report, /"pageErrors": 1/u);
  const transfers = networkRequests(report);
  const redirected = transfers.find((request) => request.status === 302);
  const document = transfers.find(
    (request) => request.url === `${appUrl}/login`,
  );
  const script = transfers.find(
    (request) => request.url === `${appUrl}/slow.js`,
  );
  assert.ok(redirected && document && script);
  assert.equal(redirected.outcome, "redirected");
  assert.equal(redirected.cfRay, "0123456789abcdef-SJC");
  assert.equal(document.requestId, redirected.requestId);
  assert.equal(document.cfRay, "fedcba9876543210-LHR");
  assert.equal(document.outcome, "finished");
  assert.ok(typeof document.totalEncodedBytes === "number");
  assert.ok(
    typeof document.decodedDataBytes === "number" &&
      document.decodedDataBytes > document.totalEncodedBytes,
  );
  assert.equal(script.outcome, "pending");
  assert.equal(script.dataEvents, 0);
  assert.ok(transfers.some((request) => request.outcome === "failed"));
  assert.doesNotMatch(
    report,
    /secret|Authorization|Bearer|Set-Cookie|handshake|\?/iu,
  );
});

test(
  "sign-in report bounds request history and reports omissions",
  { timeout: 15_000 },
  async (context) => {
    let markRequested: () => void = () => {};
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    let resources = 0;
    const { page, diagnosticPath, signIn } = await fixture(
      context,
      (request, response) => {
        if (request.url === "/sign-in") {
          response.writeHead(200, { "content-type": "text/html" }).end(`
        <script>for (let i = 0; i < 90; i++) fetch('/resource/' + i);</script>
        <script defer src="/slow.js"></script>`);
        } else if (request.url?.startsWith("/resource/")) {
          response.end("ok");
          if (++resources === 90) markRequested();
        }
      },
    );
    page.setDefaultNavigationTimeout(30_000);
    await Promise.all([
      assert.rejects(signIn, /page.goto:.*closed/u),
      requested.then(() => page.close()),
    ]);
    const report = await readFile(diagnosticPath, "utf8");
    const value: unknown = JSON.parse(report);
    assert.ok(isRecord(value) && Array.isArray(value.requests));
    assert.equal(value.requests.length, 64);
    assert.equal(networkRequests(report).length, 64);
    assert.match(report, /"omittedRequests": [1-9]\d*/u);
  },
);

test(
  "an unresponsive document cannot stall failure diagnostics",
  { timeout: 15_000 },
  async (context) => {
    const { diagnosticPath, signIn } = await fixture(
      context,
      (_request, response) => {
        response
          .writeHead(200, { "content-type": "text/html" })
          .end("<script>while (true) {}</script>");
      },
    );
    await assert.rejects(signIn, errors.TimeoutError);
    assert.match(
      await readFile(diagnosticPath, "utf8"),
      /"reason": "deadline"/u,
    );
  },
);

test("closed-page diagnostics and artifact-write failures preserve the sign-in error", async (context) => {
  const { page, directory, diagnosticPath, signIn } = await fixture(
    context,
    () => {},
  );
  await page.close();
  const isClosedPageError = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /page.goto:.*closed/u);
    return true;
  };
  await assert.rejects(signIn, isClosedPageError);
  const report = await readFile(diagnosticPath, "utf8");
  assert.match(report, /"closed": true/u);
  assert.match(report, /"reason": "evaluation-failed"/u);
  assert.match(report, /"reason": "setup-failed"/u);

  // A real invalid output path exercises persistence failure, not an internal mock.
  const invalidDirectory = join(directory, "not-a-directory");
  await writeFile(invalidDirectory, "occupied");
  await assert.rejects(
    () =>
      signInRunnerWithDiagnostics(
        page,
        "fixture@example.com",
        "http://fixture.test",
        {
          activeOrganizationId: "org_fixture",
          diagnosticPath: join(invalidDirectory, "report.json"),
        },
      ),
    isClosedPageError,
  );
});

test("successful runner sign-in returns its token without a diagnostic artifact", async (context) => {
  const { diagnosticPath, directory, signIn } = await fixture(
    context,
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end(`
      <label>Email address <input type="email"></label>
      <button onclick="document.getElementById('code').hidden = false">Continue</button>
      <input id="code" hidden aria-label="Enter verification code"
        oninput="if(this.value === '424242') {
          window.Clerk.session = {getToken: async () => 'token-secret'};
          history.replaceState(null, '', '/ready');
        }">
      <script>
        window.__okouClerkBootstrap = { runtime: Promise.resolve() };
        window.Clerk = {
          loaded: true,
          organization: {id: 'org_fixture'},
          client: {signIn: {firstFactorVerification: {
            strategy: 'email_code', status: 'unverified'
          }}}
        };
      </script>`);
    },
  );
  await mkdir(join(directory, "sign-in"));
  assert.equal(await signIn(), "token-secret");
  assert.deepEqual(await readdir(join(directory, "sign-in")), []);
  await assert.rejects(() => stat(diagnosticPath), { code: "ENOENT" });
});
