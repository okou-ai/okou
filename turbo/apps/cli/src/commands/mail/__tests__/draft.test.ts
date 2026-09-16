import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { draftCommand } from "../draft";
import { mailCommand } from "../index";

const UPLOAD_URL =
  "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts";
const MESSAGE = Buffer.from(
  'From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Draft test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="example"\r\n\r\n--example\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n你好, review this draft.\r\n--example\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="sample.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==\r\n--example--\r\n',
);

describe("okou mail draft", () => {
  let directory: string;
  let messageFile: string;
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "okou-mail-draft-"));
    messageFile = join(directory, "message.eml");
    await writeFile(messageFile, MESSAGE);
    vi.stubEnv("OKOU_AGENT_ID", "550e8400-e29b-41d4-a716-446655440000");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "550e8400-e29b-41d4-a716-446655440001");
    vi.stubEnv("GMAIL_TOKEN", "synthetic-run-gmail-binding");
    draftCommand.setOptionValue("file", undefined);
    draftCommand.setOptionValue("json", false);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("command exited");
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.mocked(process.exit).mockRestore();
    vi.unstubAllEnvs();
    output.mockClear();
    errors.mockClear();
  });

  it("uploads the RFC822 bytes once and hands the draft to Web review", async () => {
    const drafts: Uint8Array[] = [];
    server.use(
      http.post(UPLOAD_URL, async ({ request }) => {
        expect(new URL(request.url).searchParams.get("uploadType")).toBe(
          "media",
        );
        expect(request.headers.get("Authorization")).toBe(
          "Bearer synthetic-run-gmail-binding",
        );
        expect(request.headers.get("Content-Type")).toBe("message/rfc822");
        drafts.push(new Uint8Array(await request.arrayBuffer()));
        return HttpResponse.json({
          id: "r-created-draft",
          message: { id: "message-1" },
        });
      }),
    );

    await mailCommand.parseAsync([
      "node",
      "okou",
      "draft",
      "--file",
      messageFile,
      "--json",
    ]);

    expect(drafts).toHaveLength(1);
    expect(Buffer.from(drafts[0]!)).toEqual(MESSAGE);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
      gmailDraftId: "r-created-draft",
      sent: false,
      nextStep:
        "Run okou mail link r-created-draft, return the review URL, and let the user review and send.",
    });
    expect(errors).not.toHaveBeenCalled();
  });

  it("gives a Gmail handoff outside Web chat instead of an unusable link command", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "");
    server.use(
      http.post(UPLOAD_URL, () => {
        return HttpResponse.json({ id: "r-slack-draft" });
      }),
    );

    await mailCommand.parseAsync([
      "node",
      "okou",
      "draft",
      "--file",
      messageFile,
    ]);

    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("Gmail draft created: r-slack-draft");
    expect(text).toContain(
      "Ask the user to review and send this draft in Gmail",
    );
    expect(text).not.toContain("okou mail link");
  });

  it("requires the run's Gmail binding and guides connection", async () => {
    vi.stubEnv("GMAIL_TOKEN", "");

    await expect(
      mailCommand.parseAsync(["node", "okou", "draft", "--file", messageFile]),
    ).rejects.toThrow("command exited");

    expect(errors.mock.calls.flat().join("\n")).toContain(
      "okou mail connect gmail",
    );
    expect(output).not.toHaveBeenCalled();
  });

  it.each(["empty", "oversized", "directory", "missing"])(
    "rejects a %s input before upload",
    async (kind) => {
      let path = messageFile;
      if (kind === "empty") {
        await writeFile(path, "");
      } else if (kind === "oversized") {
        await truncate(path, 35 * 1024 * 1024 + 1);
      } else if (kind === "directory") {
        path = directory;
      } else {
        path = join(directory, "missing.eml");
      }
      await expect(
        mailCommand.parseAsync(["node", "okou", "draft", "--file", path]),
      ).rejects.toThrow("command exited");
      expect(output).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalled();
    },
  );

  it("reports a rejected upload without echoing provider body contents", async () => {
    let requests = 0;
    server.use(
      http.post(UPLOAD_URL, () => {
        requests++;
        return HttpResponse.json(
          { error: "private message content" },
          { status: 403 },
        );
      }),
    );

    await expect(
      mailCommand.parseAsync(["node", "okou", "draft", "--file", messageFile]),
    ).rejects.toThrow("command exited");

    const text = errors.mock.calls.flat().join("\n");
    expect(requests).toBe(1);
    expect(text).toContain("HTTP 403");
    expect(text).toContain("okou connector check");
    expect(text).not.toContain("private message content");
    expect(text).not.toContain("synthetic-run-gmail-binding");
  });

  it.each(["network", "server", "invalid-json", "invalid-id", "redirect"])(
    "does not replay an uncertain %s result",
    async (kind) => {
      let requests = 0;
      let redirected = false;
      server.use(
        http.post(UPLOAD_URL, () => {
          requests++;
          switch (kind) {
            case "network":
              return HttpResponse.error();
            case "server":
              return new HttpResponse(null, { status: 503 });
            case "invalid-json":
              return new HttpResponse("unreadable response");
            case "invalid-id":
              return HttpResponse.json({ id: "draft; echo unsafe" });
            default:
              return new HttpResponse(null, {
                status: 307,
                headers: { Location: "https://other.example/upload" },
              });
          }
        }),
        http.post("https://other.example/upload", () => {
          redirected = true;
          return HttpResponse.json({ id: "wrong-draft" });
        }),
      );

      await expect(
        mailCommand.parseAsync([
          "node",
          "okou",
          "draft",
          "--file",
          messageFile,
        ]),
      ).rejects.toThrow("command exited");

      expect(requests).toBe(1);
      expect(redirected).toBe(false);
      expect(errors.mock.calls.flat().join("\n")).toContain(
        "Inspect Gmail drafts before retrying",
      );
      expect(output).not.toHaveBeenCalled();
    },
  );
});
