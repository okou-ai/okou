import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createNotifyCommand } from "../index";

const url = "http://localhost:3000/api/notifications";
const id = randomUUID();
const receipt = {
  notificationId: id,
  channel: "mail",
  recipient: "me",
  status: "queued",
  reason: null,
  deduplicated: false,
};
const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});

beforeEach(() => {
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  vi.stubEnv("OKOU_TOKEN", "test-token");
});
const run = (...args: string[]) => {
  return createNotifyCommand().parseAsync(["node", "okou", ...args]);
};
const args = [
  "mail",
  "--subject",
  "Your brief",
  "--idempotency-key",
  "brief:2026-10-08",
  "--json",
];

describe("okou notify", () => {
  it("reads piped stdin as Markdown", async () => {
    const input = vi
      .spyOn(process.stdin, Symbol.asyncIterator)
      .mockImplementation(async function* () {
        yield Buffer.from("# 今日\nUseful update.\n");
        return undefined;
      });
    try {
      server.use(
        http.post(`${url}/mail`, async ({ request }) => {
          expect(await request.json()).toMatchObject({
            text: "# 今日\nUseful update.\n",
          });
          return HttpResponse.json(receipt);
        }),
      );
      await run(...args);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(receipt));
    } finally {
      input.mockRestore();
    }
  });
  it("sends Markdown with a stable key and prints an honest JSON receipt", async () => {
    let captured: unknown;
    server.use(
      http.post(`${url}/mail`, async ({ request }) => {
        captured = await request.json();
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json(receipt);
      }),
    );
    await run(...args, "--text", "## Today\nUseful update.");
    expect(captured).toStrictEqual({
      to: "me",
      kind: "notification",
      subject: "Your brief",
      text: "## Today\nUseful update.",
      idempotencyKey: "brief:2026-10-08",
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(receipt));
  });

  it("sends the explicit Morning Brief purpose without client-supplied presentation links", async () => {
    server.use(
      http.post(`${url}/mail`, async ({ request }) => {
        expect(await request.json()).toStrictEqual({
          to: "me",
          kind: "morning-brief",
          subject: "Your brief",
          text: "## Today\nUseful update.",
          idempotencyKey: "brief:2026-10-08",
        });
        return HttpResponse.json(receipt);
      }),
    );
    await run(
      ...args,
      "--kind",
      "morning-brief",
      "--text",
      "## Today\nUseful update.",
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(receipt));
  });

  it("reads a UTF-8 Markdown file without modifying its content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "notify-mail-"));
    try {
      const file = join(directory, "brief.md");
      const text = "# 今日\nA useful update.\n";
      await writeFile(file, text);
      server.use(
        http.post(`${url}/mail`, async ({ request }) => {
          expect(await request.json()).toMatchObject({ text });
          return HttpResponse.json({
            ...receipt,
            status: "skipped",
            reason: "unsubscribed",
          });
        }),
      );
      await run(...args, "--file", file);
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          ...receipt,
          status: "skipped",
          reason: "unsubscribed",
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["recipient", ["--to", "someone@example.com", "--text", "hello"]],
    ["unknown kind", ["--kind", "custom-template", "--text", "hello"]],
    ["empty body", ["--text", " "]],
    [
      "subject newline",
      ["--subject", "hello\nBCC: someone@example.com", "--text", "hello"],
    ],
    ["oversized body", ["--text", "x".repeat(8001)]],
    ["multiple inputs", ["--file", "brief.md", "--text", "hello"]],
  ])(
    "rejects %s with a structured error before sending",
    async (_name, extra) => {
      let requests = 0;
      server.use(
        http.post(`${url}/mail`, () => {
          requests += 1;
          return HttpResponse.json(receipt);
        }),
      );
      await expect(run(...args, ...extra)).rejects.toThrow(
        "process.exit called",
      );
      expect(requests).toBe(0);
      expect(error.mock.calls[0]?.[0]).toContain('"code":"INVALID_INPUT"');
    },
  );

  it("preserves conflict errors so retries can reuse the original content", async () => {
    server.use(
      http.post(`${url}/mail`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "CONFLICT",
              message: "Key already has different content",
            },
          },
          { status: 409 },
        );
      }),
    );
    await expect(run(...args, "--text", "hello")).rejects.toThrow(
      "process.exit called",
    );
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        error: {
          code: "CONFLICT",
          message: "Key already has different content",
          status: 409,
        },
      }),
    );
  });

  it("reports transport failure without misclassifying it as invalid input", async () => {
    server.use(
      http.post(`${url}/mail`, () => {
        return HttpResponse.error();
      }),
    );
    await expect(run(...args, "--text", "hello")).rejects.toThrow(
      "process.exit called",
    );
    expect(error.mock.calls[0]?.[0]).toContain('"code":"NOTIFICATION_ERROR"');
    expect(log).not.toHaveBeenCalled();
  });

  it("queries status without claiming provider acceptance is inbox delivery", async () => {
    server.use(
      http.get(`${url}/${id}`, () => {
        return HttpResponse.json({ ...receipt, status: "sent" });
      }),
    );
    await run("get", id);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "inbox delivery is not confirmed",
    );
    await run("get", id, "--json");
    expect(log).toHaveBeenLastCalledWith(
      JSON.stringify({ ...receipt, status: "sent" }),
    );
  });
});
