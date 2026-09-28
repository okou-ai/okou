import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { runCleanup } from "./cleanup";

const server = setupServer();
const prefix = "pi-api-first-turn/";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  vi.stubEnv("R2_ACCOUNT_ID", "cleanup-test");
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");
  vi.stubEnv("R2_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("S3_ENDPOINT", undefined);
  vi.stubEnv("S3_REGION", "auto");
  vi.stubEnv("S3_FORCE_PATH_STYLE", "true");
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function xml(body: string): HttpResponse {
  return new HttpResponse(body, {
    headers: { "Content-Type": "application/xml" },
  });
}

function storage(
  options: {
    readonly rejectDelete?: boolean;
    readonly wrongPrefix?: boolean;
  } = {},
) {
  const objects = new Set([
    `${prefix}run-a/manifest.json`,
    `${prefix}run-a/session.jsonl`,
    `${prefix}run-b/manifest.json`,
    "pi-api-first-turn-other/keep.json",
    "session-history/keep.jsonl",
  ]);
  server.use(
    http.all(
      /^https:\/\/cleanup-test\.r2\.cloudflarestorage\.com\//u,
      async ({ request }) => {
        const url = new URL(request.url);
        expect(url.pathname.replace(/\/$/u, "")).toBe("/test-bucket");
        if (request.method === "GET") {
          expect(url.searchParams.get("prefix")).toBe(prefix);
          if (options.wrongPrefix) {
            return xml(
              "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>session-history/keep.jsonl</Key></Contents></ListBucketResult>",
            );
          }
          const cursor = url.searchParams.get("continuation-token");
          const selected = [...objects]
            .filter((key) => {
              return key.startsWith(prefix) && (!cursor || key > cursor);
            })
            .sort();
          const limit = Math.min(2, Number(url.searchParams.get("max-keys")));
          const page = selected.slice(0, limit);
          const truncated = selected.length > page.length;
          return xml(
            `<ListBucketResult><IsTruncated>${String(truncated)}</IsTruncated>${
              truncated
                ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>`
                : ""
            }${page
              .map((key) => {
                return `<Contents><Key>${key}</Key></Contents>`;
              })
              .join("")}</ListBucketResult>`,
          );
        }
        expect(request.method).toBe("POST");
        expect(url.searchParams.has("delete")).toBeTruthy();
        const body = await request.text();
        const keys = [...body.matchAll(/<Key>([^<]+)<\/Key>/gu)].map(
          (match) => {
            return match[1];
          },
        );
        expect(keys.length).toBeGreaterThan(0);
        if (options.rejectDelete) {
          return xml(
            `<DeleteResult><Error><Key>${keys[0]}</Key><Code>AccessDenied</Code><Message>Denied</Message></Error></DeleteResult>`,
          );
        }
        for (const key of keys) {
          expect(key?.startsWith(prefix)).toBeTruthy();
          if (key) objects.delete(key);
        }
        return xml("<DeleteResult />");
      },
    ),
  );
  return objects;
}

it("inventories every page without deleting objects by default", async () => {
  const objects = storage();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await runCleanup([]);
  expect(objects.size).toBe(5);
  expect(output).toHaveBeenCalledWith(
    JSON.stringify({
      mode: "dry-run",
      bucket: "test-bucket",
      prefix,
      objects: 3,
      deleted: 0,
      verifiedEmpty: false,
    }),
  );
});

it("deletes all retired pages and preserves unrelated objects", async () => {
  const objects = storage();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await runCleanup(["--execute"]);
  expect([...objects]).toStrictEqual([
    "pi-api-first-turn-other/keep.json",
    "session-history/keep.jsonl",
  ]);
  expect(output).toHaveBeenCalledWith(
    JSON.stringify({
      mode: "execute",
      bucket: "test-bucket",
      prefix,
      objects: 3,
      deleted: 3,
      verifiedEmpty: true,
    }),
  );
});

it("fails on a per-object error even when DeleteObjects returns HTTP 200", async () => {
  const objects = storage({ rejectDelete: true });
  await expect(runCleanup(["--execute"])).rejects.toThrow(
    "Storage rejected 1 object deletions; cleanup is incomplete",
  );
  expect(objects.size).toBe(5);
});

it("never deletes an out-of-prefix object returned by storage", async () => {
  const objects = storage({ wrongPrefix: true });
  await expect(runCleanup(["--execute"])).rejects.toThrow(
    "Storage returned an object outside the retired prefix",
  );
  expect(objects.size).toBe(5);
});
