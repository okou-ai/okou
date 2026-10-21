import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { onTestFinished } from "vitest";

import { testContext } from "./test-context";

const context = testContext();
const execute = promisify(execFile);
const apiRoot = fileURLToPath(new URL("../../", import.meta.url));

// Build through the production config, then exercise its exported Node listener.
// A small app isolates the build/transport boundary from production credentials.
const appSource = `
import { Hono } from 'hono';
import { stream } from 'hono/streaming';

const app = new Hono();
let finishStream;
const released = new Promise((resolve) => { finishStream = resolve; });

app.post('/echo', async (c) => {
  const headers = new Headers({ 'content-type': c.req.header('content-type') });
  headers.append('set-cookie', 'first=1; Path=/; HttpOnly');
  headers.append('set-cookie', 'second=2; Path=/; HttpOnly');
  headers.set('x-request-path', c.req.path);
  return new Response(await c.req.arrayBuffer(), { status: 201, headers });
});
app.get('/stream', (c) => stream(c, async (output) => {
  await output.write('first');
  await released;
  await output.write('second');
}));
app.post('/release', (c) => {
  finishStream();
  return c.body(null, 204);
});
export default app;
`;

const probeSource = `
import { once } from 'node:events';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const { default: listener } = await import(pathToFileURL(process.argv[1]));
const server = createServer(listener);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
try {
  const body = Buffer.from([0, 1, 127, 128, 255]);
  const response = await fetch(base + '/echo?source=preview', {
    method: 'POST', body, headers: { 'content-type': 'application/octet-stream' },
  });
  const echoed = Array.from(new Uint8Array(await response.arrayBuffer()));
  const streaming = await fetch(base + '/stream');
  const reader = streaming.body.getReader();
  const first = await reader.read();
  const released = await fetch(base + '/release', { method: 'POST' });
  let remaining = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    remaining += new TextDecoder().decode(chunk.value);
  }
  process.stdout.write(JSON.stringify({
    status: response.status,
    contentType: response.headers.get('content-type'),
    path: response.headers.get('x-request-path'),
    cookies: response.headers.getSetCookie(),
    echoed,
    streamStatus: streaming.status,
    first: new TextDecoder().decode(first.value),
    releaseStatus: released.status,
    remaining,
  }));
} finally {
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}
`;

describe("Vercel build", () => {
  it("preserves request bodies, cookies and streaming through the generated Node listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-vercel-build-"));
    onTestFinished(() => {
      return rm(root, { recursive: true, force: true });
    });
    await mkdir(join(root, "src"));
    await symlink(
      join(apiRoot, "node_modules"),
      join(root, "node_modules"),
      "dir",
    );
    await writeFile(join(root, "src/index.ts"), appSource);
    await execute(
      process.execPath,
      [
        join(apiRoot, "node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        join(apiRoot, "vite.config.ts"),
      ],
      { cwd: root, signal: context.signal },
    );
    const { stdout } = await execute(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        probeSource,
        join(root, ".vercel/output/functions/__hono.func/index.js"),
      ],
      { cwd: root, signal: context.signal },
    );
    expect(JSON.parse(stdout)).toStrictEqual({
      status: 201,
      contentType: "application/octet-stream",
      path: "/echo",
      cookies: ["first=1; Path=/; HttpOnly", "second=2; Path=/; HttpOnly"],
      echoed: [0, 1, 127, 128, 255],
      streamStatus: 200,
      first: "first",
      releaseStatus: 204,
      remaining: "second",
    });
  });
});
