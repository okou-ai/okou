import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  marketingHandoffsContract,
  type MarketingHandoffFile,
  type MarketingHandoffManifest,
} from "@okouai/api-contracts/contracts/marketing-handoffs";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { describe, expect, it } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { marketingHandoffsRoutes } from "../marketing-handoffs";
import { webFileUrlRoutes } from "../web-file-url";

const context = testContext();
const authorization = "Bearer clerk-session";

interface Account {
  readonly userId: string;
  readonly orgId: string;
}

function account(): Account {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string | undefined;
  readonly metadata: Record<string, string> | undefined;
}

/** Private R2 buckets for handoff content and imported artifacts. */
function objectStorage() {
  mockEnv("R2_MARKETING_HANDOFF_BUCKET_NAME", "test-marketing-handoffs");
  mockEnv("R2_MARKETING_HANDOFF_ACCESS_KEY_ID", "handoff-access-key");
  mockEnv("R2_MARKETING_HANDOFF_SECRET_ACCESS_KEY", "handoff-secret-key");
  const objects = new Map<string, StoredObject>();
  const etag = (body: Buffer) => {
    return `"${createHash("sha256").update(body).digest("hex")}"`;
  };
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const key = `${command.input.Bucket}/${command.input.Key}`;
      if (command.input.IfNoneMatch === "*" && objects.has(key)) {
        return Promise.reject(
          Object.assign(new Error("Object already exists"), {
            name: "PreconditionFailed",
            $metadata: { httpStatusCode: 412 },
          }),
        );
      }
      const body = command.input.Body;
      if (typeof body !== "string" && !(body instanceof Uint8Array)) {
        return Promise.reject(new Error("Expected object bytes"));
      }
      const bytes = Buffer.from(body);
      objects.set(key, {
        body: bytes,
        contentType: command.input.ContentType,
        metadata: command.input.Metadata,
      });
      return Promise.resolve({ ETag: etag(bytes) });
    }
    if (
      command instanceof HeadObjectCommand ||
      command instanceof GetObjectCommand
    ) {
      const stored = objects.get(
        `${command.input.Bucket}/${command.input.Key}`,
      );
      if (!stored) {
        return Promise.reject(
          Object.assign(new Error("Object is missing"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      const head = {
        ContentLength: stored.body.length,
        ContentType: stored.contentType,
        Metadata: stored.metadata,
        ETag: etag(stored.body),
      };
      return Promise.resolve(
        command instanceof GetObjectCommand
          ? { ...head, Body: Readable.from([stored.body]) }
          : head,
      );
    }
    return Promise.reject(new Error("Unexpected storage operation"));
  });
}

interface Browser {
  readonly origin: string;
  cookie: string | null;
}

function browser(origin = new URL(env("APP_URL")).origin): Browser {
  return { origin, cookie: null };
}

function handoffs() {
  return setupApp({ context, routes: marketingHandoffsRoutes })(
    marketingHandoffsContract,
  );
}

/** Request headers for a browser, optionally signed in and sending its cookie. */
function request(from: Browser, signedIn: Account | null, withCookie: boolean) {
  if (signedIn) {
    createRouteMocks(context).clerk.session(signedIn.userId, signedIn.orgId);
  }
  return {
    headers: signedIn ? { authorization } : {},
    extraHeaders: {
      origin: from.origin,
      ...(withCookie && from.cookie ? { cookie: from.cookie } : {}),
    },
  };
}

/** The browser obtains a guest handoff cookie. */
async function startSession(from: Browser, signedIn: Account | null = null) {
  const response = await accept(
    handoffs().session({ ...request(from, signedIn, false), body: {} }),
    [200],
  );
  const setCookie = response.headers.get("set-cookie") ?? "";
  from.cookie = setCookie.split(";")[0] ?? null;
  return setCookie;
}

async function upload(
  from: Browser,
  signedIn: Account | null,
  filename: string,
  text: string,
): Promise<MarketingHandoffFile> {
  const response = await accept(
    handoffs().upload({
      ...request(from, signedIn, true),
      body: {
        filename,
        contentType: "text/plain",
        data: Buffer.from(text).toString("base64"),
      },
    }),
    [200],
  );
  return response.body;
}

function manifest(
  prompt: string,
  files: readonly MarketingHandoffFile[] = [],
): MarketingHandoffManifest {
  return { version: 1, prompt, options: {}, files: [...files] };
}

async function submit(
  from: Browser,
  signedIn: Account | null,
  body: MarketingHandoffManifest,
  withCookie = true,
) {
  const response = await accept(
    handoffs().create({ ...request(from, signedIn, withCookie), body }),
    [200],
  );
  return response.body;
}

async function resolveStatus(
  from: Browser,
  signedIn: Account,
  hash: string,
  withCookie: boolean,
) {
  const response = await handoffs().resolve({
    ...request(from, signedIn, withCookie),
    params: { hash },
    body: {},
  });
  return response.status;
}

async function importFiles(
  from: Browser,
  signedIn: Account,
  hash: string,
  intentId: string,
  withCookie = true,
) {
  const response = await accept(
    handoffs().import({
      ...request(from, signedIn, withCookie),
      params: { hash },
      body: { intentId },
    }),
    [200],
  );
  return response.body;
}

describe("Marketing content handoff", () => {
  it("marketing-handoffs-019 rejects requests from another origin even when the user is authenticated", async () => {
    objectStorage();
    const user = account();

    const response = await handoffs().create({
      ...request(browser("https://untrusted.example"), user, false),
      body: manifest(`Untrusted ${randomUUID()}`),
    });

    expect(response.status).toBe(403);
  });

  it("marketing-handoffs-007 does not grant another user access merely because they know the hash", async () => {
    objectStorage();
    const page = browser();
    const created = await submit(
      page,
      account(),
      manifest(`Private ${randomUUID()}`),
    );

    await expect(
      resolveStatus(page, account(), created.shortHash, false),
    ).resolves.toBe(404);
  });

  it("marketing-handoffs-003 keeps identical content stable, versions edits, and leaves the old manifest readable", async () => {
    objectStorage();
    const page = browser();
    const user = account();
    const original = manifest(`Version one ${randomUUID()}`);

    const first = await submit(page, user, original);
    const duplicate = await submit(page, user, original);
    const edited = await submit(
      page,
      user,
      manifest(`${original.prompt} edited`),
    );

    expect(first.shortHash).toBe(first.hash.slice(0, 12));
    expect(duplicate.hash).toBe(first.hash);
    expect(edited.hash).not.toBe(first.hash);
    for (const hash of [first.hash, first.shortHash]) {
      const resolved = await accept(
        handoffs().resolve({
          ...request(page, user, false),
          params: { hash },
          body: {},
        }),
        [200],
      );
      expect(resolved.body).toStrictEqual(original);
    }
  });

  it("marketing-handoffs-008 gives independent grants to two users who submit identical content", async () => {
    objectStorage();
    const page = browser();
    const first = account();
    const content = manifest(`Shared idea ${randomUUID()}`);

    const fromFirst = await submit(page, first, content);
    const fromSecond = await submit(page, account(), content);

    expect(fromSecond.hash).toBe(fromFirst.hash);
    await expect(
      resolveStatus(page, first, fromFirst.hash, false),
    ).resolves.toBe(200);
  });

  it("marketing-handoffs-016 cannot attach another account's file by hash", async () => {
    objectStorage();
    const page = browser();
    const file = await upload(
      page,
      account(),
      "notes.txt",
      `notes ${randomUUID()}`,
    );

    const response = await handoffs().create({
      ...request(page, account(), false),
      body: manifest("Use these notes", [file]),
    });

    expect(response.status).toBe(404);
  });

  it("marketing-handoffs-010 authorizes every account with the same cookie and retains their independent grants", async () => {
    objectStorage();
    const page = browser();
    const setCookie = await startSession(page);
    expect(setCookie).toMatch(/HttpOnly/u);
    expect(setCookie).toMatch(/Secure/u);
    expect(setCookie).not.toMatch(/Domain=/iu);
    const created = await submit(page, null, manifest(`Guest ${randomUUID()}`));
    const accounts = [account(), account(), account()];

    const statuses = [];
    for (const each of accounts) {
      statuses.push(await resolveStatus(page, each, created.hash, true));
      statuses.push(await resolveStatus(page, each, created.hash, false));
    }
    const fourth = account();
    const otherPage = browser();
    await startSession(otherPage);
    statuses.push(await resolveStatus(page, fourth, created.hash, false));
    statuses.push(await resolveStatus(otherPage, fourth, created.hash, true));
    const [firstAccount] = accounts;
    if (!firstAccount) {
      throw new Error("Expected the first account");
    }
    statuses.push(await resolveStatus(page, firstAccount, created.hash, false));

    expect(statuses).toStrictEqual([
      200, 200, 200, 200, 200, 200, 404, 404, 200,
    ]);
  });

  it("marketing-handoffs-011 does not authorize a new account with an expired cookie", async () => {
    objectStorage();
    const start = Date.parse("2026-10-01T00:00:00Z");
    mockNow(new Date(start));
    const page = browser();
    await startSession(page);
    const created = await submit(page, null, manifest(`Guest ${randomUUID()}`));
    const receiver = account();
    await expect(
      resolveStatus(page, receiver, created.hash, true),
    ).resolves.toBe(200);

    mockNow(new Date(start + 7 * 24 * 60 * 60 * 1000 + 1000));

    await expect(
      resolveStatus(page, receiver, created.hash, false),
    ).resolves.toBe(200);
    await expect(
      resolveStatus(page, account(), created.hash, true),
    ).resolves.toBe(404);
  });

  it("marketing-handoffs-012 shares authenticated submissions and their files with the submitting browser session", async () => {
    objectStorage();
    const page = browser();
    const author = account();
    const second = account();
    const third = account();
    await startSession(page, author);
    const text = `shared ${randomUUID()}`;
    const file = await upload(page, author, "shared.txt", text);
    const original = await submit(page, author, manifest("Original", [file]));

    await expect(
      resolveStatus(page, second, original.hash, true),
    ).resolves.toBe(200);
    const edit = await submit(page, second, manifest("Second edit", [file]));
    const imported = await importFiles(page, second, edit.hash, randomUUID());
    expect(
      imported.files.map(({ filename, size }) => {
        return { filename, size };
      }),
    ).toStrictEqual([
      { filename: "shared.txt", size: Buffer.byteLength(text) },
    ]);

    await submit(page, third, manifest("Third edit", [file]));
    await expect(resolveStatus(page, third, edit.hash, true)).resolves.toBe(
      200,
    );
  });

  it("marketing-handoffs-015 keeps guest-uploaded files authorized after sign-in and prompt editing", async () => {
    objectStorage();
    const page = browser();
    await startSession(page);
    const file = await upload(page, null, "guest.txt", `guest ${randomUUID()}`);
    const original = await submit(page, null, manifest("Guest prompt", [file]));
    const user = account();

    await expect(resolveStatus(page, user, original.hash, true)).resolves.toBe(
      200,
    );
    const edited = await submit(page, user, manifest("Edited prompt", [file]));
    expect(edited.hash).not.toBe(original.hash);
    await expect(
      importFiles(page, user, edited.hash, randomUUID()),
    ).resolves.toMatchObject({ files: [{ filename: "guest.txt" }] });
  });

  it("marketing-handoffs-017 imports files privately with stable identities on retry", async () => {
    objectStorage();
    const page = browser();
    const owner = account();
    const file = await upload(
      page,
      owner,
      "notes.txt",
      `notes ${randomUUID()}`,
    );
    const created = await submit(page, owner, manifest("Notes", [file]), false);
    const intentId = randomUUID();

    const first = await importFiles(page, owner, created.hash, intentId, false);
    const retry = await importFiles(
      page,
      owner,
      created.shortHash,
      intentId,
      false,
    );
    const another = await importFiles(
      page,
      owner,
      created.hash,
      randomUUID(),
      false,
    );

    expect(retry).toStrictEqual(first);
    expect(
      first.files.map((each) => {
        return each.filename;
      }),
    ).toStrictEqual(["notes.txt"]);
    const [imported] = first.files;
    if (!imported) {
      throw new Error("Expected one imported file");
    }
    expect(another.files[0]?.id).not.toBe(imported.id);
    const fileUrl = (who: Account) => {
      createRouteMocks(context).clerk.session(who.userId, who.orgId);
      return setupApp({ context, routes: webFileUrlRoutes })(
        webFilesContract,
      ).fileUrl({
        headers: { authorization },
        query: { file_id: imported.id },
      });
    };
    const ownerUrl = await fileUrl(owner);
    const otherUrl = await fileUrl(account());
    expect([ownerUrl.status, otherUrl.status]).toStrictEqual([200, 404]);
  });
});
