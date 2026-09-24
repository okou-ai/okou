import { existsSync, watch } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DesktopClerkNative } from "./desktop-clerk-native";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

it("exchanges tokens and organization choices with a private native process", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clerk-auth-helper-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const helperPath = path.join(dir, "helper");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  const result = request.command === "organizations"
    ? { organizations: [{ id: "org_1", name: "Workspace" }] }
    : request.command === "signOut"
      ? {}
      : { token: request.organizationId === "org_1" ? "org-token" : "session-token" };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
  );
  await chmod(helperPath, 0o755);

  const native = new DesktopClerkNative("pk_test_public", helperPath);
  cleanup.push(async () => native.dispose());
  expect(await native.getToken()).toBe("session-token");
  expect(await native.organizations()).toEqual([
    { id: "org_1", name: "Workspace" },
  ]);
  expect(await native.setOrganization("org_1")).toBe("org-token");
  await native.signOut();
});

it("starts a fresh helper after cancelling sign-in without letting the old exit reject sign-out", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clerk-auth-cancel-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const helperPath = path.join(dir, "helper");
  const signInStarted = path.join(dir, "sign-in-started");
  const signOutStarted = path.join(dir, "sign-out-started");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const signInStarted = ${JSON.stringify(signInStarted)};
const signOutStarted = ${JSON.stringify(signOutStarted)};
process.on("SIGTERM", () => {
  if (fs.existsSync(signOutStarted)) process.exit(0);
  const watcher = fs.watch(${JSON.stringify(dir)}, () => {
    if (fs.existsSync(signOutStarted)) {
      watcher.close();
      process.exit(0);
    }
  });
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.command === "signIn") {
    fs.writeFileSync(signInStarted, "ready");
  } else if (request.command === "signOut") {
    fs.writeFileSync(signOutStarted, "ready");
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
    }, 50);
  }
});
`,
  );
  await chmod(helperPath, 0o755);

  const native = new DesktopClerkNative("pk_test_public", helperPath);
  cleanup.push(async () => native.dispose());
  const signInReady = new Promise<void>((resolve) => {
    const watcher = watch(dir, () => {
      if (existsSync(signInStarted)) {
        watcher.close();
        resolve();
      }
    });
  });
  const controller = new AbortController();
  const signIn = native.signIn(controller.signal);
  await signInReady;
  controller.abort();
  await expect(signIn).rejects.toThrow("cancelled");
  await expect(native.signOut()).resolves.toBeUndefined();
  expect(existsSync(signOutStarted)).toBe(true);
});
