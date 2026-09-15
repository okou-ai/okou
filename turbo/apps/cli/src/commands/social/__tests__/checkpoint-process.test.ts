import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, it } from "vitest";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "okou-collection-process-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function invoke(args: string[], failPage = false) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          "--import",
          fileURLToPath(new URL("./fixtures/process-http.ts", import.meta.url)),
          fileURLToPath(new URL("../../../okou.ts", import.meta.url)),
          join(directory, "requests.jsonl"),
          failPage ? "1" : "0",
          "social",
          ...args,
        ],
        {
          env: {
            PATH: process.env.PATH,
            OKOU_TOKEN: "test-okou-token",
            OKOU_API_BACKEND_URL: "http://social-fixture.invalid",
            SENTRY_DSN: "",
          },
          timeout: 20_000,
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(error);
            return;
          }
          resolve({
            code: error && typeof error.code === "number" ? error.code : 0,
            stdout,
            stderr,
          });
        },
      );
    },
  );
}

it("recovers a buffered tail through three independent real CLI processes", async () => {
  const checkpoint = join(directory, "comments.json");
  const first = await invoke([
    "comments",
    "https://instagram.com/p/example",
    "--limit",
    "2",
    "--checkpoint",
    checkpoint,
    "--json",
  ]);
  expect(first.code, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout) as unknown).toMatchObject({
    data: { items: [{ id: "one" }, { id: "two" }] },
  });
  const second = await invoke([
    "resume",
    checkpoint,
    "--limit",
    "1",
    "--stream",
  ]);
  expect(second.code, second.stderr).toBe(0);
  const records: unknown[] = second.stdout
    .trim()
    .split("\n")
    .map((line) => {
      return JSON.parse(line);
    });
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    source: "checkpoint",
    data: { items: [{ id: "three" }] },
  });
  expect(records[1]).toMatchObject({
    kind: "summary",
    billing: { quantity: 0, creditsCharged: 0 },
  });
  expect(
    (await readFile(join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n"),
  ).toHaveLength(1);
  const third = await invoke(["resume", checkpoint, "--limit", "10", "--json"]);
  expect(third.code, third.stderr).toBe(0);
  expect(JSON.parse(third.stdout) as unknown).toMatchObject({
    data: { items: [{ id: "four" }] },
    collection: {
      cumulative: {
        pages: 2,
        itemsReturned: 4,
        itemsObserved: 4,
        creditsCharged: 6,
      },
      continuation: { available: false },
    },
  });
  const requests: unknown[] = (
    await readFile(join(directory, "requests.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => {
      return JSON.parse(line);
    });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toHaveProperty("input.cursor", "next");
});

it("recovers a later failed page in another process without refetching page one", async () => {
  const checkpoint = join(directory, "comments.json");
  const first = await invoke(
    [
      "comments",
      "https://instagram.com/p/example",
      "--limit",
      "10",
      "--checkpoint",
      checkpoint,
      "--json",
    ],
    true,
  );
  expect(first.code, first.stderr).toBe(1);
  expect(JSON.parse(first.stdout) as unknown).toMatchObject({
    collection: { state: "failed", itemsReturned: 3 },
  });
  const second = await invoke([
    "resume",
    checkpoint,
    "--limit",
    "10",
    "--json",
  ]);
  expect(second.code, second.stderr).toBe(0);
  expect(JSON.parse(second.stdout) as unknown).toMatchObject({
    data: { items: [{ id: "four" }] },
    collection: {
      cumulative: { pages: 2, itemsReturned: 4, creditsCharged: 6 },
    },
  });
  const requests: unknown[] = (
    await readFile(join(directory, "requests.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => {
      return JSON.parse(line);
    });
  expect(requests).toHaveLength(3);
  expect(requests[1]).toHaveProperty("input.cursor", "next");
  expect(requests[2]).toHaveProperty("input.cursor", "next");
});
