import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const wrapper = fileURLToPath(
  new URL("../../scripts/with-http-proxy.mjs", import.meta.url),
);
const username = "proxy-fixture-user";
const password = "proxy-fixture-@:%&password";
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HTTP_PROXY: "",
    http_proxy: "",
    HTTPS_PROXY: "",
    https_proxy: "",
    ALL_PROXY: "",
    all_proxy: "",
    NO_PROXY: "",
    no_proxy: "",
    NODE_USE_ENV_PROXY: "0",
    E2E_HTTP_PROXY_URL: "",
    E2E_HTTP_PROXY_SERVER: "",
    E2E_HTTP_PROXY_PORT: "",
    E2E_HTTP_PROXY_USERNAME: "",
    E2E_HTTP_PROXY_PASSWORD: "",
    ...extra,
  };
}

async function run(args: string[], env: NodeJS.ProcessEnv) {
  try {
    const result = await exec(process.execPath, [wrapper, ...args], {
      env,
      timeout: 25_000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    assert.ok(
      error &&
        typeof error === "object" &&
        "code" in error &&
        "stdout" in error &&
        "stderr" in error,
    );
    return {
      code: error.code,
      stdout: String(error.stdout),
      stderr: String(error.stderr),
    };
  }
}

async function listen(context: TestContext, server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

test("unset proxy preserves direct requests and child exit status; partial secrets fail without disclosure", async (context) => {
  const origin = createServer((_request, response) => response.end("direct"));
  const port = await listen(context, origin);
  const result = await run(
    [
      "node",
      "-e",
      `fetch('http://127.0.0.1:${port}').then(async r => { console.log(await r.text()); process.exitCode = 7; })`,
    ],
    environment(),
  );
  assert.equal(result.code, 7);
  assert.match(result.stdout, /direct/u);
  const invalid = await run(
    ["node", "-e", "console.log('CHILD_STARTED')"],
    environment({ E2E_HTTP_PROXY_PASSWORD: password }),
  );
  assert.equal(invalid.code, 1);
  assert.doesNotMatch(invalid.stdout, /CHILD_STARTED/u);
  assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes(password));
});

test(
  "cancellation reaches the child and releases the local proxy",
  { timeout: 10_000 },
  async (context) => {
    const child = spawn(
      process.execPath,
      [wrapper, "node", "-e", "process.stdin.resume(); console.log('READY');"],
      {
        env: environment({
          E2E_HTTP_PROXY_SERVER: "127.0.0.1",
          E2E_HTTP_PROXY_PORT: "1",
          E2E_HTTP_PROXY_USERNAME: username,
          E2E_HTTP_PROXY_PASSWORD: password,
        }),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    context.after(() => {
      child.kill("SIGKILL");
    });
    const lines = createInterface({ input: child.stdout });
    context.after(() => lines.close());
    const exited = once(child, "exit");
    const [line] = await once(lines, "line");
    assert.equal(line, "READY");
    child.kill("SIGHUP");
    const [code] = await exited;
    assert.equal(code, 129);
  },
);

test(
  "authenticated proxy carries curl, Node and Playwright HTTPS traffic without publishing credentials",
  { timeout: 60_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-http-proxy-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=proxy-fixture.invalid",
      "-addext",
      "subjectAltName=DNS:proxy-fixture.invalid",
    ]);
    const origin = createHttpsServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" }).end("proxied");
      },
    );
    const originPort = await listen(context, origin);
    const httpOrigin = createServer((_request, response) =>
      response.end("proxied"),
    );
    const httpOriginPort = await listen(context, httpOrigin);
    let httpRequests = 0;
    let tunnels = 0;
    const proxy = createServer((request, response) => {
      if (request.headers["proxy-authorization"] !== authorization) {
        response
          .writeHead(407, { "Proxy-Authenticate": 'Basic realm="fixture"' })
          .end();
        return;
      }
      httpRequests++;
      response.end("proxied");
    });
    proxy.on("connect", (request, socket, head) => {
      if (request.headers["proxy-authorization"] !== authorization) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      tunnels++;
      const target = connect(
        request.url?.endsWith(":80") ? httpOriginPort : originPort,
        "127.0.0.1",
        () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) target.write(head);
          socket.pipe(target).pipe(socket);
        },
      );
      target.on("error", () => socket.destroy());
      socket.on("error", () => target.destroy());
      socket.on("close", () => target.destroy());
    });
    const port = await listen(context, proxy);
    const env = environment({
      E2E_HTTP_PROXY_SERVER: "127.0.0.1",
      E2E_HTTP_PROXY_PORT: String(port),
      E2E_HTTP_PROXY_USERNAME: username,
      E2E_HTTP_PROXY_PASSWORD: password,
      NODE_EXTRA_CA_CERTS: cert,
      CURL_CA_BUNDLE: cert,
    });
    const script = `
    const assert = require('node:assert/strict');
    const {execFileSync} = require('node:child_process');
    (async () => {
      for (const name of ['SERVER', 'PORT', 'USERNAME', 'PASSWORD']) assert.equal(process.env['E2E_HTTP_PROXY_' + name], undefined);
      const proxy = new URL(process.env.HTTPS_PROXY);
      assert.equal(proxy.username, ''); assert.equal(proxy.password, '');
      for (const url of ['http://proxy-fixture.invalid/', 'https://proxy-fixture.invalid/']) {
        assert.equal(await (await fetch(url)).text(), 'proxied');
        assert.equal(execFileSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '5', url], {encoding:'utf8'}), 'proxied');
      }
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `;
    const network = await run(["node", "-e", script], env);
    assert.equal(network.code, 0, `${network.stdout}${network.stderr}`);
    assert.ok(httpRequests >= 1);
    assert.ok(tunnels >= 2);

    const config = join(directory, "playwright.config.cjs");
    await writeFile(
      config,
      `module.exports = ${JSON.stringify({
        testDir: fileURLToPath(new URL("./fixtures", import.meta.url)),
        testMatch: "http-proxy.spec.ts",
        outputDir: join(directory, "results"),
        reporter: [["blob", { outputDir: join(directory, "blob") }]],
        workers: 1,
        retries: 0,
        timeout: 10_000,
        use: {
          baseURL: "https://proxy-fixture.invalid",
          ignoreHTTPSErrors: true,
          trace: "on",
        },
      })};`,
    );
    const playwright = await run(
      [
        "node",
        require.resolve("@playwright/test/cli"),
        "test",
        "--config",
        config,
      ],
      env,
    );
    assert.equal(
      playwright.code,
      0,
      `${playwright.stdout}${playwright.stderr}`,
    );
    const inspectArchives = `
import io, pathlib, sys, zipfile
secrets = sys.argv[2:]
def inspect(data):
    if data.startswith(b'PK'):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for name in archive.namelist():
                inspect(archive.read(name))
    else:
        for secret in secrets:
            assert secret.encode() not in data, 'Proxy credential found in report or trace'
for path in pathlib.Path(sys.argv[1]).rglob('*.zip'):
    inspect(path.read_bytes())
`;
    await exec("python3", [
      "-c",
      inspectArchives,
      directory,
      username,
      password,
      encodeURIComponent(password),
      authorization,
    ]);
  },
);

test("proxy authentication failure does not fall back to a reachable direct origin", async (context) => {
  let directRequests = 0;
  const origin = createServer((_request, response) => {
    directRequests++;
    response.end("direct");
  });
  const originPort = await listen(context, origin);
  const proxy = createServer((_request, response) =>
    response.writeHead(407).end(),
  );
  const port = await listen(context, proxy);
  const result = await run(
    [
      "curl",
      "--fail",
      "--silent",
      "--max-time",
      "5",
      `http://127.0.0.1:${originPort}`,
    ],
    environment({
      E2E_HTTP_PROXY_SERVER: "127.0.0.1",
      E2E_HTTP_PROXY_PORT: String(port),
      E2E_HTTP_PROXY_USERNAME: username,
      E2E_HTTP_PROXY_PASSWORD: password,
    }),
  );
  assert.notEqual(result.code, 0);
  assert.equal(directRequests, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
});
