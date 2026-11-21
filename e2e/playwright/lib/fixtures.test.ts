import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const testDir = fileURLToPath(new URL("./fixtures", import.meta.url));

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

for (const scenario of ["success", "body-failure", "route-failure"]) {
  test(
    `page route teardown preserves ${scenario}`,
    { timeout: 30_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "page-route-fixture-"));
      let pendingResponse: ServerResponse | undefined;
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const server = createServer((request, response) => {
        switch (request.url) {
          case "/":
            response
              .writeHead(200, { "Content-Type": "text/html" })
              .end(
                "<button onclick=\"fetch('/api/user-preferences')\">Load preferences</button>",
              );
            break;
          case "/api/user-preferences":
            pendingResponse = response;
            markStarted();
            break;
          case "/started":
            void started.then(() => response.writeHead(204).end());
            break;
          case "/release":
            response.writeHead(204).end();
            assert.ok(pendingResponse);
            pendingResponse
              .writeHead(200, { "Content-Type": "application/json" })
              .end(JSON.stringify({ theme: "light" }));
            break;
          default:
            response.writeHead(404).end();
        }
      });

      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const config = join(directory, "playwright.config.cjs");
        await writeFile(
          config,
          `module.exports = ${JSON.stringify({
            testDir,
            testMatch: "route-teardown.spec.ts",
            outputDir: join(directory, "results"),
            reporter: "list",
            workers: 1,
            retries: 0,
            timeout: 10_000,
            use: { baseURL: `http://127.0.0.1:${address.port}` },
          })};`,
        );
        const result = await runPlaywright(config, scenario);
        const output = result.stdout + result.stderr;
        assert.equal(result.code, scenario === "success" ? 0 : 1, output);
        assert.match(output, /^BODY_FINISHED$/mu);
        assert.match(output, /^PAGE_CLOSED$/mu);
        assert.doesNotMatch(
          output,
          /Target page, context or browser has been closed/u,
        );
        assert.doesNotMatch(output, /Timeout|timed out/u);
        assert.doesNotMatch(output, /Response has been disposed/u);
        assert.doesNotMatch(output, /Error: ROUTE_NOT_DRAINED/u);

        if (scenario === "route-failure") {
          assert.match(output, /Error: INTENTIONAL_ROUTE_FAILURE/u);
          assert.doesNotMatch(output, /^ROUTE_COMPLETED$/mu);
        } else {
          assert.match(output, /^ROUTE_COMPLETED$/mu);
          assert.ok(
            output.indexOf("BODY_FINISHED") < output.indexOf("ROUTE_COMPLETED"),
            output,
          );
          assert.ok(
            output.indexOf("ROUTE_COMPLETED") < output.indexOf("PAGE_CLOSED"),
            output,
          );
          if (scenario === "body-failure") {
            assert.match(output, /Error: INTENTIONAL_BODY_FAILURE/u);
          }
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

function runPlaywright(config: string, scenario: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        require.resolve("@playwright/test/cli"),
        "test",
        "--config",
        config,
        "--grep",
        `${scenario}$`,
      ],
      {
        timeout: 20_000,
        env: { ...process.env, VERCEL_AUTOMATION_BYPASS_SECRET: "" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
        } else if (typeof error.code === "number") {
          resolve({ code: error.code, stdout, stderr });
        } else {
          reject(error);
        }
      },
    );
  });
}
