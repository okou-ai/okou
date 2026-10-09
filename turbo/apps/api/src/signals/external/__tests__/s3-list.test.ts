import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { listS3ObjectsPage } from "../s3";

const context = testContext();
const bucket = "test-user-storages";
const prefix = "chat-events/";
const modified = "2026-09-01T00:00:00Z";

function metadata(key: string) {
  return { Key: key, Size: 10, LastModified: new Date(modified) };
}

function listingRequests() {
  return context.mocks.s3.send.mock.calls.map(([request]) => {
    if (!(request instanceof ListObjectsV2Command)) {
      throw new Error("Expected an S3 ListObjectsV2 request");
    }
    return request.input;
  });
}

/**
 * Provider-boundary exception, matching s3-delete.test.ts: no public endpoint
 * accepts arbitrary bucket/prefix/cursor pages or exposes provider settlement.
 * Validate the shared adapter with the centralized external SDK mock, not a
 * private cron driver. These cases do not assert GC policy or database progress.
 */
describe("bounded S3 object listing provider contract", () => {
  it("preserves first-page requests, zero-byte objects and cancellation ownership", async () => {
    const object = { ...metadata(`${prefix}object`), Size: 0 };
    context.mocks.s3.send.mockResolvedValue({ Contents: [object] });

    await expect(
      createStore().get(
        listS3ObjectsPage(bucket, prefix, 1000, context.signal),
      ),
    ).resolves.toStrictEqual({
      objects: [{ key: object.Key, size: 0, lastModified: new Date(modified) }],
      isTruncated: false,
    });
    expect(listingRequests()).toStrictEqual([
      { Bucket: bucket, Prefix: prefix, MaxKeys: 1000 },
    ]);
    expect(context.mocks.s3.send.mock.calls[0]?.[1]).toStrictEqual({
      abortSignal: context.signal,
    });
  });

  it("returns an empty completed page without fetching again", async () => {
    context.mocks.s3.send.mockResolvedValue({
      Contents: [],
      IsTruncated: false,
    });
    await expect(
      createStore().get(listS3ObjectsPage(bucket, prefix, 1000)),
    ).resolves.toStrictEqual({ objects: [], isTruncated: false });
    expect(listingRequests()).toHaveLength(1);
  });

  it("can continue past 1000 unchanged versions of one thread without subdividing its UUID", async () => {
    const threadPrefix = `${prefix}12340000-0000-4000-8000-000000000000/`;
    const keys = Array.from({ length: 1501 }, (_, index) => {
      return `${threadPrefix}${index.toString()}-r1-${"a".repeat(64)}.ndjson.gz`;
    }).sort();
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      if (!(request instanceof ListObjectsV2Command)) {
        throw new Error("Expected an S3 ListObjectsV2 request");
      }
      const { StartAfter, MaxKeys } = request.input;
      if (MaxKeys === undefined) {
        throw new Error("Expected a bounded listing");
      }
      const remaining = keys.filter((key) => {
        return StartAfter === undefined || key > StartAfter;
      });
      return Promise.resolve({
        Contents: remaining.slice(0, MaxKeys).map(metadata),
        IsTruncated: remaining.length > MaxKeys,
      });
    });
    const store = createStore();
    const first = await store.get(
      listS3ObjectsPage(bucket, prefix, 1000, context.signal),
    );
    expect(first.objects).toHaveLength(1000);
    expect(first.isTruncated).toBeTruthy();
    // The adapter owns one page only, even when the provider has more objects.
    expect(listingRequests()).toHaveLength(1);
    const cursor = first.objects.at(-1)?.key;
    if (cursor === undefined) {
      throw new Error("Expected the first page's resume key");
    }
    const second = await store.get(
      listS3ObjectsPage(bucket, prefix, 1000, context.signal, cursor),
    );
    expect(second.isTruncated).toBeFalsy();
    expect(
      [...first.objects, ...second.objects].map((object) => {
        return object.key;
      }),
    ).toStrictEqual(keys);
    expect(listingRequests()).toStrictEqual([
      { Bucket: bucket, Prefix: prefix, MaxKeys: 1000 },
      { Bucket: bucket, Prefix: prefix, MaxKeys: 1000, StartAfter: cursor },
    ]);
  });

  it("resumes after a key that was deleted between page requests", async () => {
    const cursor = `${prefix}first`;
    const nextKey = `${prefix}second`;
    context.mocks.s3.send
      .mockResolvedValueOnce({
        Contents: [metadata(cursor)],
        IsTruncated: true,
      })
      .mockResolvedValueOnce({
        Contents: [metadata(nextKey)],
        IsTruncated: false,
      });
    const store = createStore();
    const first = await store.get(listS3ObjectsPage(bucket, prefix, 1));
    expect(first.objects[0]?.key).toBe(cursor);
    // The later provider response contains no cursor object. StartAfter is a
    // key position, not an offset into the surviving object count.
    const next = await store.get(
      listS3ObjectsPage(bucket, prefix, 1, context.signal, cursor),
    );
    expect(
      next.objects.map((object) => {
        return object.key;
      }),
    ).toStrictEqual([nextKey]);
    expect(listingRequests()[1]?.StartAfter).toBe(cursor);
  });

  it("uses UTF-8 provider key order rather than UTF-16 string order", async () => {
    const keys = [`${prefix}\uE000`, `${prefix}\u{10000}`];
    context.mocks.s3.send.mockResolvedValue({ Contents: keys.map(metadata) });
    const page = await createStore().get(listS3ObjectsPage(bucket, prefix, 2));
    expect(
      page.objects.map((object) => {
        return object.key;
      }),
    ).toStrictEqual(keys);
  });

  it.each([0, -1, 1001, 1.5])(
    "rejects page size %s before a provider request",
    (maxKeys) => {
      expect(() => {
        return listS3ObjectsPage(bucket, prefix, maxKeys);
      }).toThrow("S3 list page size must be an integer between 1 and 1000");
      expect(context.mocks.s3.send).not.toHaveBeenCalled();
    },
  );

  it("rejects a cursor outside the requested namespace", () => {
    expect(() => {
      return listS3ObjectsPage(
        bucket,
        prefix,
        1000,
        context.signal,
        "other/key",
      );
    }).toThrow("S3 list cursor must belong to its prefix");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "missing key",
      item: { Size: 10, LastModified: new Date(modified) },
    },
    {
      label: "missing size",
      item: { Key: `${prefix}one`, LastModified: new Date(modified) },
    },
    { label: "negative size", item: { ...metadata(`${prefix}one`), Size: -1 } },
    { label: "missing date", item: { Key: `${prefix}one`, Size: 10 } },
    {
      label: "invalid date",
      item: { ...metadata(`${prefix}one`), LastModified: new Date("invalid") },
    },
  ])(
    "rejects $label instead of silently dropping an object",
    async ({ item }) => {
      context.mocks.s3.send.mockResolvedValue({ Contents: [item] });
      await expect(
        createStore().get(listS3ObjectsPage(bucket, prefix, 1000)),
      ).rejects.toThrow(
        "S3 object listing returned incomplete object metadata",
      );
    },
  );

  it("rejects objects outside the requested prefix", async () => {
    context.mocks.s3.send.mockResolvedValue({
      Contents: [metadata("other/key")],
    });
    await expect(
      createStore().get(listS3ObjectsPage(bucket, prefix, 1000)),
    ).rejects.toThrow("S3 object listing escaped its prefix");
  });

  it.each([
    {
      label: "cursor replay",
      keys: [`${prefix}two`],
      startAfter: `${prefix}two`,
    },
    {
      label: "duplicate key",
      keys: [`${prefix}one`, `${prefix}one`],
      startAfter: undefined,
    },
    {
      label: "reversed page",
      keys: [`${prefix}two`, `${prefix}one`],
      startAfter: undefined,
    },
  ])(
    "rejects $label instead of allowing a non-advancing checkpoint",
    async ({ keys, startAfter }) => {
      context.mocks.s3.send.mockResolvedValue({ Contents: keys.map(metadata) });
      await expect(
        createStore().get(
          listS3ObjectsPage(bucket, prefix, 1000, context.signal, startAfter),
        ),
      ).rejects.toThrow("S3 object listing did not advance its cursor");
    },
  );

  it.each([
    {
      label: "truncated empty page",
      response: { Contents: [], IsTruncated: true },
    },
    {
      label: "oversized page",
      response: {
        Contents: [metadata(`${prefix}one`), metadata(`${prefix}two`)],
        IsTruncated: false,
      },
    },
  ])("rejects a $label", async ({ response }) => {
    context.mocks.s3.send.mockResolvedValue(response);
    await expect(
      createStore().get(listS3ObjectsPage(bucket, prefix, 1)),
    ).rejects.toThrow("S3 object listing returned an invalid bounded page");
  });

  it("propagates a provider rejection without retries or implicit pages", async () => {
    const error = new Error("Provider unavailable");
    context.mocks.s3.send.mockRejectedValue(error);
    await expect(
      createStore().get(listS3ObjectsPage(bucket, prefix, 1000)),
    ).rejects.toBe(error);
    expect(listingRequests()).toHaveLength(1);
  });

  it("makes no provider request for an already cancelled owner", async () => {
    const reason = new DOMException("Owner cancelled", "AbortError");
    const signal = AbortSignal.abort(reason);
    await expect(
      createStore().get(listS3ObjectsPage(bucket, prefix, 1000, signal)),
    ).rejects.toBe(reason);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("does not publish a page after cancellation while its provider response is pending", async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const started = createDeferredPromise<void>(context.signal);
    const response = createDeferredPromise<object>(context.signal);
    context.mocks.s3.send.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const listing = settleIncludingAbort(
      createStore().get(listS3ObjectsPage(bucket, prefix, 1000, signal)),
    );
    await started.promise;
    const reason = new DOMException("Owner cancelled", "AbortError");
    controller.abort(reason);
    response.resolve({ Contents: [metadata(`${prefix}one`)] });
    await expect(listing).resolves.toStrictEqual({ ok: false, error: reason });
    expect(context.mocks.s3.send.mock.calls[0]?.[1]).toStrictEqual({
      abortSignal: signal,
    });
    expect(listingRequests()).toHaveLength(1);
  });
});
