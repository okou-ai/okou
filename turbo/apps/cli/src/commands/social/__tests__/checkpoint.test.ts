import { createHmac, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { server } from "../../../mocks/server";
import { socialCommand } from "../index";

const endpoint = "http://localhost:3000/api/social/request";
const target = "https://instagram.com/p/example";
const exit = new Error("observed process exit");
let directory: string;
let checkpoint: string;
let token: string;
const originalExitCode = process.exitCode;

function response(ids: string[], cursor?: string) {
  return {
    tool: "instagram_comments",
    billingCategory: "request",
    billingQuantity: 1,
    creditsCharged: 3,
    collection: cursor
      ? { state: "more", itemsReturned: ids.length, nextInput: { cursor } }
      : { state: "complete", itemsReturned: ids.length },
    result: {
      comments: ids.map((id) => {
        return { id };
      }),
      hasMore: !!cursor,
    },
  };
}

async function invoke(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
    throw exit;
  });
  process.exitCode = undefined;
  for (const command of socialCommand.commands) {
    for (const option of command.options) {
      command.setOptionValue(option.attributeName(), option.defaultValue);
    }
  }
  try {
    await socialCommand.parseAsync(["node", "okou", ...args]);
  } catch (error) {
    if (error !== exit) throw error;
  }
  const records: unknown[] = log.mock.calls.map(([value]) => {
    return JSON.parse(String(value));
  });
  const errors = errorLog.mock.calls.flat().join("\n");
  const code = exitSpy.mock.calls[0]?.[0] ?? process.exitCode ?? 0;
  log.mockRestore();
  errorLog.mockRestore();
  exitSpy.mockRestore();
  return { records, result: records.at(-1), errors, code };
}

function start(limit = "2", extra: string[] = []) {
  return invoke([
    "comments",
    target,
    "--limit",
    limit,
    "--checkpoint",
    checkpoint,
    "--json",
    ...extra,
  ]);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "okou-social-checkpoint-"));
  checkpoint = join(directory, "comments.json");
  token = randomBytes(32).toString("hex");
  vi.stubEnv("OKOU_TOKEN", token);
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = originalExitCode;
  await rm(directory, { recursive: true, force: true });
});

describe("social collection checkpoints through the CLI", () => {
  it("resumes a large Unicode tail intact without another provider request", async () => {
    const text = "A多字节🙂".repeat(20_000);
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests += 1;
        return HttpResponse.json({
          ...response(["one", "two"]),
          result: {
            comments: [{ id: "one" }, { id: "two", text }],
            hasMore: false,
          },
        });
      }),
    );
    expect((await start("1")).code).toBe(0);
    const resumed = await invoke([
      "resume",
      checkpoint,
      "--limit",
      "1",
      "--json",
    ]);
    expect(resumed.code, resumed.errors).toBe(0);
    expect(resumed.result).toMatchObject({
      data: { items: [{ id: "two", text }] },
      billing: { quantity: 0 },
    });
    expect(requests).toBe(1);
  });

  it("rejects oversized checkpoint files before reading provider data", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests += 1;
        return HttpResponse.json(response([]));
      }),
    );
    await writeFile(checkpoint, "");
    await truncate(checkpoint, 16 * 1024 * 1024 + 1);
    const resumed = await invoke(["resume", checkpoint, "--json"]);
    expect(resumed.code).toBe(1);
    expect(resumed.errors).toContain("at most 16 MiB");
    expect(requests).toBe(0);
  });

  it("preserves the buffered page context when a later page overshoots", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests += 1;
        const first = requests === 1;
        const page = response(
          first ? ["one"] : ["two", "three", "four"],
          first ? "next" : undefined,
        );
        return HttpResponse.json({
          ...page,
          result: { ...page.result, commentCount: first ? 10 : 11 },
        });
      }),
    );
    const initial = await start("3");
    expect(initial.result).toHaveProperty("data.context.commentCount", 10);
    const resumed = await invoke([
      "resume",
      checkpoint,
      "--limit",
      "1",
      "--stream",
    ]);
    expect(resumed.records[0]).toMatchObject({
      source: "checkpoint",
      data: { items: [{ id: "four" }], context: { commentCount: 11 } },
    });
    expect(requests).toBe(2);
  });

  it.each(["posts", "search"])(
    "retains the reviewed %s binding across recovery",
    async (operation) => {
      const requests: unknown[] = [];
      const posts = operation === "posts";
      server.use(
        http.post(endpoint, async ({ request }) => {
          requests.push(await request.json());
          const first = requests.length === 1;
          return HttpResponse.json({
            tool: posts ? "instagram_channel_reels" : "tiktok_search",
            billingCategory: "request",
            billingQuantity: 1,
            creditsCharged: 3,
            collection: first
              ? {
                  state: "more",
                  itemsReturned: 1,
                  nextInput: { cursor: "next" },
                }
              : { state: "complete", itemsReturned: 1 },
            result: {
              [posts ? "items" : "results"]: [{ id: first ? "one" : "two" }],
              hasMore: first,
              ...(first ? { cursor: "next" } : {}),
            },
          });
        }),
      );
      const args = posts
        ? ["posts", "https://instagram.com/example", "--kind", "reels"]
        : [
            "search",
            "  product launch  ",
            "--platform",
            "tiktok",
            "--sort",
            "likes",
            "--date",
            "week",
          ];
      const first = await invoke([
        ...args,
        "--limit",
        "1",
        "--checkpoint",
        checkpoint,
        "--json",
      ]);
      expect(first.code, first.errors).toBe(0);
      const resumed = await invoke([
        "resume",
        checkpoint,
        "--limit",
        "1",
        "--json",
      ]);
      expect(resumed.code, resumed.errors).toBe(0);
      expect(resumed.result).toMatchObject({
        operation,
        platform: posts ? "instagram" : "tiktok",
        collection: { cumulative: { itemsReturned: 2 } },
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject(
        posts
          ? {
              tool: "instagram_channel_reels",
              input: {
                url: "https://www.instagram.com/example",
                cursor: "next",
              },
            }
          : {
              tool: "tiktok_search",
              input: { query: "product launch", cursor: "next" },
            },
      );
      expect(resumed.result).toHaveProperty(
        posts ? "request.kind" : "request.sort",
        posts ? "reels" : "likes",
      );
    },
  );

  it.each(["empty", "first_failure"])(
    "does not invent recovery after %s",
    async (kind) => {
      server.use(
        http.post(endpoint, () => {
          return kind === "empty"
            ? HttpResponse.json(response([]))
            : HttpResponse.json(
                {
                  error: {
                    code: "UPSTREAM_ERROR",
                    message: "Temporary failure",
                    retryable: true,
                  },
                },
                { status: 502 },
              );
        }),
      );
      const result = await start();
      expect(result.code).toBe(kind === "empty" ? 0 : 1);
      expect(result.result).toMatchObject({
        data: { items: [] },
        collection: { continuation: { available: false } },
      });
      if (kind === "first_failure")
        expect(result.result).toMatchObject({ status: "error", billing: null });
      expect((await invoke(["resume", checkpoint, "--json"])).code).toBe(1);
    },
  );

  it("preserves accepted output when the checkpoint cannot be published", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, async () => {
        requests += 1;
        await mkdir(checkpoint);
        return HttpResponse.json(response(["one", "two", "three"], "next"));
      }),
    );
    const result = await start();
    expect(result.code).toBe(1);
    expect(result.result).toMatchObject({
      status: "partial",
      data: { items: [{ id: "one" }, { id: "two" }] },
      collection: {
        state: "failed",
        cumulative: { pages: 1, itemsObserved: 3 },
      },
      billing: { quantity: 1, creditsCharged: 3 },
    });
    expect(result.result).not.toHaveProperty("collection.continuation");
    expect(result.errors).toContain("could not be saved");
    expect(requests).toBe(1);
    await expect(stat(`${checkpoint}.lock`)).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it.each([false, true])(
    "replays the two-of-three tail without requests (source has more: %s)",
    async (hasMore) => {
      const requests: unknown[] = [];
      server.use(
        http.post(endpoint, async ({ request }) => {
          requests.push(await request.json());
          return HttpResponse.json(
            requests.length === 1
              ? response(["one", "two", "three"], hasMore ? "next" : undefined)
              : response(["four"]),
          );
        }),
      );
      const first = await start();
      expect(first.code).toBe(0);
      expect(first.result).toMatchObject({
        data: { items: [{ id: "one" }, { id: "two" }] },
        collection: {
          state: "caller_limited",
          itemsObserved: 3,
          continuation: { available: true, bufferedItems: 1 },
          cumulative: {
            pages: 1,
            itemsReturned: 2,
            itemsObserved: 3,
            creditsCharged: 3,
          },
        },
      });
      const second = await invoke([
        "resume",
        checkpoint,
        "--limit",
        "1",
        "--stream",
      ]);
      expect(second.code).toBe(0);
      expect(second.records).toHaveLength(2);
      expect(second.records[0]).toMatchObject({
        kind: "page",
        source: "checkpoint",
        data: { items: [{ id: "three" }] },
        billing: { quantity: 0, creditsCharged: 0 },
      });
      expect(second.result).toMatchObject({
        kind: "summary",
        billing: { quantity: 0, creditsCharged: 0 },
        collection: {
          pages: 0,
          itemsReturned: 1,
          itemsObserved: 0,
          bufferedItemsReturned: 1,
          cumulative: {
            pages: 1,
            itemsReturned: 3,
            itemsObserved: 3,
            creditsCharged: 3,
          },
          continuation: { available: hasMore, bufferedItems: 0 },
        },
      });
      expect(second.result).not.toHaveProperty("data");
      expect(requests).toHaveLength(1);
      const third = await invoke([
        "resume",
        checkpoint,
        "--limit",
        "5",
        "--json",
      ]);
      if (hasMore) {
        expect(third.result).toMatchObject({
          data: { items: [{ id: "four" }] },
          collection: {
            state: "complete",
            cumulative: { pages: 2, itemsReturned: 4, creditsCharged: 6 },
          },
        });
        expect(requests).toHaveLength(2);
        expect(requests[1]).toHaveProperty("input.cursor", "next");
        expect(requests[1]).toHaveProperty("input.limit", 5);
      } else {
        expect(third.code).toBe(1);
        expect(third.errors).toContain("exhausted");
        expect(requests).toHaveLength(1);
      }
      expect((await stat(checkpoint)).mode & 0o777).toBe(0o600);
      expect(await readFile(checkpoint, "utf8")).not.toContain(
        "test-okou-token",
      );
    },
  );

  it("retains a tail across several resumes and preserves the exact target and filters", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(endpoint, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json(
          requests.length === 1
            ? response(["one", "two", "three", "four"], "next")
            : response(["five"]),
        );
      }),
    );
    await start("1", ["--sort", "recent"]);
    await invoke(["resume", checkpoint, "--limit", "1", "--json"]);
    const result = await invoke([
      "resume",
      checkpoint,
      "--limit",
      "10",
      "--json",
    ]);
    expect(result.result).toMatchObject({
      data: { items: [{ id: "three" }, { id: "four" }, { id: "five" }] },
      request: { sort: "recent", limit: 10, resume: true },
      collection: {
        bufferedItemsReturned: 2,
        cumulative: { itemsReturned: 5, pages: 2, creditsCharged: 6 },
      },
      billing: { quantity: 1, creditsCharged: 3 },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      tool: "instagram_comments",
      input: {
        url: "https://www.instagram.com/p/example",
        sortBy: "recent",
        cursor: "next",
        limit: 8,
      },
    });
  });

  it("resumes only a failed pending page and preserves accepted accounting", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(endpoint, async ({ request }) => {
        requests.push(await request.json());
        if (requests.length === 2)
          return HttpResponse.json(
            {
              error: {
                code: "UPSTREAM_ERROR",
                message: "Temporary page failure",
                retryable: true,
              },
            },
            { status: 502 },
          );
        return HttpResponse.json(
          requests.length === 1 ? response(["one"], "next") : response(["two"]),
        );
      }),
    );
    const first = await start("5");
    expect(first.code).toBe(1);
    expect(first.result).toMatchObject({
      status: "partial",
      data: { items: [{ id: "one" }] },
      collection: { state: "failed", continuation: { available: true } },
    });
    const resumed = await invoke([
      "resume",
      checkpoint,
      "--limit",
      "5",
      "--json",
    ]);
    expect(resumed.code).toBe(0);
    expect(resumed.result).toMatchObject({
      data: { items: [{ id: "two" }] },
      billing: { quantity: 1, creditsCharged: 3 },
      collection: {
        cumulative: { pages: 2, itemsReturned: 2, creditsCharged: 6 },
      },
    });
    expect(requests).toHaveLength(3);
    expect(requests[1]).toHaveProperty("input.cursor", "next");
    expect(requests[2]).toHaveProperty("input.cursor", "next");
  });

  it.each(["repeated", "expired"])(
    "ends continuation on a %s provider cursor",
    async (failure) => {
      let requests = 0;
      server.use(
        http.post(endpoint, () => {
          requests += 1;
          if (requests === 2 && failure === "expired")
            return HttpResponse.json(
              {
                error: {
                  code: "INVALID_CURSOR",
                  message: "Cursor expired; start a new collection",
                  retryable: false,
                },
              },
              { status: 400 },
            );
          return HttpResponse.json(response([String(requests)], "same"));
        }),
      );
      await start("1");
      const failed = await invoke([
        "resume",
        checkpoint,
        "--limit",
        "1",
        "--json",
      ]);
      expect(failed.code).toBe(1);
      expect(failed.result).toMatchObject({
        collection: { state: "failed", continuation: { available: false } },
      });
      expect(failed.result).not.toHaveProperty("collection.nextInput");
      const again = await invoke(["resume", checkpoint, "--json"]);
      expect(again.errors).toContain("cannot continue");
      expect(requests).toBe(2);
    },
  );

  it("does not fabricate continuation for a cursorless operation", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests += 1;
        return HttpResponse.json({});
      }),
    );
    const result = await invoke([
      "search",
      "launch",
      "--platform",
      "instagram",
      "--checkpoint",
      checkpoint,
      "--json",
    ]);
    expect(result.errors).toContain("no reviewed continuation");
    expect(result.code).toBe(1);
    expect(requests).toBe(0);
    await expect(stat(checkpoint)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("drains a provider-limited tail without advancing the source", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests += 1;
        return HttpResponse.json({
          ...response(["one", "two", "three"]),
          collection: {
            state: "provider_limited",
            reason: "no_pagination",
            itemsReturned: 3,
          },
        });
      }),
    );
    await start();
    const resumed = await invoke([
      "resume",
      checkpoint,
      "--limit",
      "5",
      "--json",
    ]);
    expect(resumed.code).toBe(2);
    expect(resumed.result).toMatchObject({
      data: { items: [{ id: "three" }] },
      collection: {
        state: "provider_limited",
        continuation: { available: false },
      },
      billing: { quantity: 0, creditsCharged: 0 },
    });
    expect(requests).toBe(1);
  });

  it.each([
    "altered",
    "version",
    "expired",
    "schema",
    "request",
    "token",
    "endpoint",
  ])("rejects %s checkpoints before network access", async (kind) => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests += 1;
        return HttpResponse.json(response(["one", "two", "three"], "next"));
      }),
    );
    await start();
    const envelope = z
      .object({
        version: z.number(),
        payload: z.string(),
        signature: z.string(),
      })
      .parse(JSON.parse(await readFile(checkpoint, "utf8")));
    if (kind === "version") envelope.version = 999;
    else if (kind === "token")
      vi.stubEnv("OKOU_TOKEN", "different-owner-token");
    else if (kind === "endpoint")
      vi.stubEnv("OKOU_API_BACKEND_URL", "https://another.example");
    else {
      const payload = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(envelope.payload));
      if (kind === "expired") {
        payload.createdAt = 0;
        payload.expiresAt = 86_400_000;
      } else if (kind === "schema") payload.progress = {};
      else if (kind === "request")
        payload.initialRequest = {
          tool: "instagram_comments",
          input: { url: "https://www.instagram.com/p/different", limit: 2 },
        };
      else payload.bufferedItems = [{ id: "altered" }];
      envelope.payload = JSON.stringify(payload);
      if (kind !== "altered")
        envelope.signature = createHmac("sha256", token)
          .update("okou-social-collection-v1\0http://localhost:3000\0")
          .update(envelope.payload)
          .digest("hex");
    }
    await writeFile(checkpoint, JSON.stringify(envelope));
    const result = await invoke(["resume", checkpoint, "--json"]);
    expect(result.code).toBe(1);
    expect(result.records).toHaveLength(0);
    expect(result.errors).toMatch(/Checkpoint|checkpoint/u);
    expect(requests).toBe(1);
    await expect(stat(`${checkpoint}.lock`)).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it("rejects a locked, existing, or symlinked checkpoint without another request", async () => {
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests += 1;
        return HttpResponse.json(response(["one", "two", "three"]));
      }),
    );
    await start();
    expect((await start()).code).toBe(1);
    await writeFile(`${checkpoint}.lock`, "");
    expect((await invoke(["resume", checkpoint, "--json"])).errors).toContain(
      "locked",
    );
    await rm(`${checkpoint}.lock`);
    const alias = join(directory, "alias.json");
    await symlink(checkpoint, alias);
    expect((await invoke(["resume", alias, "--json"])).code).toBe(1);
    expect(requests).toBe(1);
  });
});
