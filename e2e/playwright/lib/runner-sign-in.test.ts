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
import type { RunnerSignInNavigationOptions } from "./runner-sign-in-navigation";

async function fixture(
  context: TestContext,
  handler: RequestListener,
  expectedAppBuildSha?: string,
  navigationRetry?: RunnerSignInNavigationOptions,
) {
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
      {
        activeOrganizationId: "org_fixture",
        diagnosticPath,
        expectedAppBuildSha,
        navigationRetry,
      },
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
  assert.equal(redirected.redirectHop, 0);
  assert.equal(document.redirectHop, 1);
  assert.equal(document.documentBuild, undefined);
  assert.deepEqual(redirected.documentBuild, {
    observed: { kind: "unavailable" },
    comparison: "not-comparable",
    reason: "ineligible-response",
  });
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

function signInDocument(script = "", failVerification = false) {
  // Supply the external Clerk UI/runtime, but drive the real helper and browser.
  // Requests make completed authentication submissions observable to the peer.
  return `<!doctype html>
    ${script}
    <form>
      <label>Email address <input name="email" type="email"></label>
      <button>Continue</button>
    </form>
    <input id="code" hidden aria-label="Enter verification code">
    <script>
      window.__okouClerkBootstrap = { runtime: Promise.resolve() };
      window.Clerk = {
        loaded: true,
        organization: { id: 'org_fixture' },
        client: { signIn: { firstFactorVerification: {
          strategy: 'email_code', status: 'unverified'
        } } }
      };
      document.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        await fetch('/email', { method: 'POST', body: new FormData(event.target) });
        document.getElementById('code').hidden = false;
        if (${failVerification}) {
          Object.defineProperty(window.Clerk.client.signIn, 'firstFactorVerification', {
            get() { throw new Error('verification-fixture-failure'); }
          });
        }
      };
      document.getElementById('code').oninput = async event => {
        if (event.target.value !== '424242') return;
        await fetch('/verify', { method: 'POST', body: event.target.value });
        window.Clerk.session = { getToken: async () => 'token-secret' };
        history.replaceState(null, '', '/ready');
      };
    </script>`;
}

for (const resource of ["document", "script"]) {
  test(`runner sign-in recovers an unresponsive ${resource} and retains pre-retry evidence`, async (context) => {
    let documents = 0;
    let scripts = 0;
    let emails = 0;
    let verifications = 0;
    const { appUrl, diagnosticPath, signIn } = await fixture(
      context,
      (request, response) => {
        if (request.url === "/sign-in") {
          documents++;
          if (resource === "document" && documents === 1) return;
          response.writeHead(200, {
            "content-type": "text/html",
            "x-okou-preview-build-sha": expectedSha,
            "set-cookie": "private=header-secret",
          });
          response.end(
            signInDocument(
              resource === "script"
                ? '<script defer src="/okou-app/assets/entry.js?query-secret"></script>'
                : "",
            ),
          );
        } else if (request.url?.startsWith("/okou-app/assets/entry.js")) {
          scripts++;
          if (scripts === 1) return;
          response.writeHead(200, { "content-type": "text/javascript" }).end();
        } else if (request.url === "/email") {
          emails++;
          response.writeHead(204).end();
        } else if (request.url === "/verify") {
          verifications++;
          response.writeHead(204).end();
        } else {
          response.writeHead(404).end();
        }
      },
      expectedSha,
      { noResponseTimeoutMs: 150, timeoutMs: 5_000 },
    );
    assert.equal(await signIn(), "token-secret");
    assert.equal(documents, 2);
    assert.equal(emails, 1);
    assert.equal(verifications, 1);
    const retryPath = `${diagnosticPath}.navigation-1.json`;
    const report = await readFile(retryPath, "utf8");
    const transfer = networkRequests(report).find(
      (request) =>
        request.url ===
        (resource === "document"
          ? `${appUrl}/sign-in`
          : `${appUrl}/okou-app/assets/entry.js`),
    );
    assert.ok(transfer);
    assert.equal(transfer.outcome, "pending");
    assert.equal(transfer.status, undefined);
    assert.equal(transfer.dataEvents, 0);
    assert.match(report, /"navigationAttempt": 1/u);
    assert.doesNotMatch(report, /secret|ERR_ABORTED|\?/u);
    assert.equal((await stat(retryPath)).mode & 0o777, 0o600);
    await assert.rejects(() => stat(diagnosticPath), { code: "ENOENT" });
  });
}

test("runner navigation recovery survives an unavailable diagnostic path", async (context) => {
  let documents = 0;
  const { page, appUrl, directory } = await fixture(
    context,
    (request, response) => {
      if (request.url === "/sign-in") {
        documents++;
        if (documents === 1) return;
        response.writeHead(200, { "content-type": "text/html" });
        response.end(signInDocument());
      } else {
        response.writeHead(204).end();
      }
    },
  );
  const blockedDirectory = join(directory, "not-a-directory");
  await writeFile(blockedDirectory, "fixture");
  const token = await signInRunnerWithDiagnostics(
    page,
    "email-secret+clerk_test@example.com",
    appUrl,
    {
      activeOrganizationId: "org_fixture",
      diagnosticPath: join(blockedDirectory, "runner.json"),
      navigationRetry: { noResponseTimeoutMs: 150, timeoutMs: 5_000 },
    },
  );
  assert.equal(token, "token-secret");
  assert.equal(documents, 2);
});

test("runner sign-in does not replay authentication after navigation succeeds", async (context) => {
  let documents = 0;
  let emails = 0;
  const { diagnosticPath, signIn } = await fixture(
    context,
    (request, response) => {
      if (request.url === "/sign-in") {
        documents++;
        response.writeHead(200, { "content-type": "text/html" });
        response.end(signInDocument("", true));
      } else if (request.url === "/email") {
        emails++;
        response.writeHead(204).end();
      } else {
        response.writeHead(404).end();
      }
    },
    undefined,
    { noResponseTimeoutMs: 150, timeoutMs: 5_000 },
  );
  await assert.rejects(signIn, /verification-fixture-failure/u);
  assert.equal(documents, 1);
  assert.equal(emails, 1);
  const report = await readFile(diagnosticPath, "utf8");
  assert.match(report, /"event": "domcontentloaded"/u);
  assert.doesNotMatch(report, /verification-fixture-failure|email-secret/u);
});

const expectedSha = "0123456789abcdef0123456789abcdef01234567";
const differentSha = "abcdef0123456789abcdef0123456789abcdef01";
for (const scenario of [
  {
    title: "matching",
    header: expectedSha,
    expected: expectedSha,
    observed: { kind: "valid", sha: expectedSha },
    comparison: "match",
  },
  {
    title: "mismatching",
    header: differentSha,
    expected: expectedSha,
    observed: { kind: "valid", sha: differentSha },
    comparison: "mismatch",
  },
  {
    title: "missing",
    header: undefined,
    expected: expectedSha,
    observed: { kind: "missing" },
    comparison: "not-comparable",
    reason: "observed-missing",
  },
  {
    title: "invalid",
    header: "private-invalid-secret",
    expected: expectedSha,
    observed: { kind: "invalid" },
    comparison: "not-comparable",
    reason: "observed-invalid",
  },
  {
    title: "combined",
    header: `${expectedSha}, ${expectedSha}`,
    expected: expectedSha,
    observed: { kind: "invalid" },
    comparison: "not-comparable",
    reason: "observed-invalid",
  },
  {
    title: "missing expectation",
    header: expectedSha,
    expected: undefined,
    observed: { kind: "valid", sha: expectedSha },
    comparison: "not-comparable",
    reason: "expected-missing",
  },
  {
    title: "invalid expectation",
    header: expectedSha,
    expected: "private-expected-secret",
    observed: { kind: "valid", sha: expectedSha },
    comparison: "not-comparable",
    reason: "expected-invalid",
  },
]) {
  test(`sign-in document reports ${scenario.title} build identity without consuming a stalled response`, async (context) => {
    const { diagnosticPath, signIn } = await fixture(
      context,
      (_request, response) => {
        response.writeHead(200, {
          "content-type": "text/html",
          ...(scenario.header === undefined
            ? {}
            : { "X-Okou-Preview-Build-Sha": scenario.header }),
        });
        response.flushHeaders();
      },
      scenario.expected,
    );
    await assert.rejects(signIn, errors.TimeoutError);
    const report = await readFile(diagnosticPath, "utf8");
    const document = networkRequests(report).find(
      (request) => request.resourceType === "document",
    );
    assert.ok(document);
    assert.equal(document.redirectHop, 0);
    assert.equal(document.outcome, "pending");
    assert.equal(document.dataEvents, 0);
    assert.equal(document.totalEncodedBytes, undefined);
    assert.deepEqual(document.documentBuild, {
      observed: scenario.observed,
      comparison: scenario.comparison,
      ...(scenario.reason === undefined ? {} : { reason: scenario.reason }),
    });
    const parsed: unknown = JSON.parse(report);
    assert.ok(isRecord(parsed));
    assert.deepEqual(
      parsed.expectedAppBuild,
      scenario.expected === undefined
        ? { kind: "missing" }
        : scenario.expected === expectedSha
          ? { kind: "valid", sha: expectedSha }
          : { kind: "invalid" },
    );
    assert.doesNotMatch(
      report,
      /private-invalid-secret|private-expected-secret/u,
    );
  });
}
