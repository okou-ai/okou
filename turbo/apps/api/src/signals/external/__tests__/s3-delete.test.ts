import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { deleteS3Objects } from "../s3";

const context = testContext();
const bucket = "test-user-storages";

function objectKeys(count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => {
    return `test-prefix/object-${index.toString()}`;
  });
}

function deleteRequests() {
  return context.mocks.s3.send.mock.calls.map(([request]) => {
    if (!(request instanceof DeleteObjectsCommand)) {
      throw new Error("Expected an S3 DeleteObjects request");
    }
    return request.input;
  });
}

/**
 * Provider-boundary exception: no production endpoint accepts arbitrary key
 * lists across these buckets or exposes when each provider request settles.
 * Exercise the shared adapter's request limit, completion, and failure contract
 * with the centralized external SDK mock. Cleanup HTTP behavior is also covered
 * by cron-cleanup-sandboxes.test.ts.
 */
describe("S3 object deletion provider contract", () => {
  it("makes no provider request for an empty list", async () => {
    await expect(
      createStore().get(deleteS3Objects(bucket, [])),
    ).resolves.toBeUndefined();

    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    expect(context.mocks.s3.clientConfig).not.toHaveBeenCalled();
  });

  it.each([
    { count: 1000, sizes: [1000] },
    { count: 1001, sizes: [1000, 1] },
    { count: 2501, sizes: [1000, 1000, 501] },
  ])(
    "deletes all $count keys within the provider limit",
    async ({ count, sizes }) => {
      const keys = objectKeys(count);
      context.mocks.s3.send.mockResolvedValue({ Errors: [] });

      await expect(
        createStore().get(deleteS3Objects(bucket, keys)),
      ).resolves.toBeUndefined();

      const requests = deleteRequests();
      expect(
        requests.map((request) => {
          return request.Delete?.Objects?.length;
        }),
      ).toStrictEqual(sizes);
      expect(
        requests.map((request) => {
          return request.Bucket;
        }),
      ).toStrictEqual(
        sizes.map(() => {
          return bucket;
        }),
      );
      expect(
        requests.flatMap((request) => {
          return request.Delete?.Objects ?? [];
        }),
      ).toStrictEqual(
        keys.map((Key) => {
          return { Key };
        }),
      );
    },
  );

  it.each([
    { selectedBucket: "test-user-storages", accessKeyId: "test-access-key" },
    {
      selectedBucket: "test-user-artifacts",
      accessKeyId: "test-artifacts-access-key",
    },
    {
      selectedBucket: "test-private-artifacts",
      accessKeyId: "test-private-access-key",
    },
  ])(
    "preserves the client and bucket for $selectedBucket across batches",
    async ({ selectedBucket, accessKeyId }) => {
      context.mocks.s3.send.mockResolvedValue({});

      await createStore().get(
        deleteS3Objects(selectedBucket, objectKeys(1001)),
      );

      expect(context.mocks.s3.clientConfig).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          credentials: expect.objectContaining({ accessKeyId }),
        }),
      );
      expect(
        deleteRequests().map((request) => {
          return request.Bucket;
        }),
      ).toStrictEqual([selectedBucket, selectedBucket]);
    },
  );

  it("awaits each batch and does not complete before the final provider response", async () => {
    const firstStarted = createDeferredPromise<void>(context.signal);
    const secondStarted = createDeferredPromise<void>(context.signal);
    const firstResponse = createDeferredPromise<object>(context.signal);
    const secondResponse = createDeferredPromise<object>(context.signal);
    context.mocks.s3.send
      .mockImplementationOnce(() => {
        firstStarted.resolve();
        return firstResponse.promise;
      })
      .mockImplementationOnce(() => {
        secondStarted.resolve();
        return secondResponse.promise;
      });

    let completed = false;
    const deletion = settleIncludingAbort(
      createStore()
        .get(deleteS3Objects(bucket, objectKeys(1001)))
        .then(() => {
          completed = true;
        }),
    );
    await firstStarted.promise;
    expect(deleteRequests()).toHaveLength(1);
    expect(completed).toBeFalsy();

    firstResponse.resolve({});
    await secondStarted.promise;
    expect(deleteRequests()).toHaveLength(2);
    expect(completed).toBeFalsy();

    secondResponse.resolve({});
    await expect(deletion).resolves.toStrictEqual({
      ok: true,
      value: undefined,
    });
    expect(completed).toBeTruthy();
  });

  it.each(["request rejection", "per-key error"] as const)(
    "rejects a later batch's %s without sending or retrying more batches",
    async (failure) => {
      const keys = objectKeys(2501);
      const providerError = new Error("S3 request failed");
      context.mocks.s3.send.mockResolvedValueOnce({});
      if (failure === "request rejection") {
        context.mocks.s3.send.mockRejectedValueOnce(providerError);
      } else {
        context.mocks.s3.send.mockResolvedValueOnce({
          Deleted: [{ Key: keys[1000] }],
          Errors: [{ Key: keys[1001], Code: "AccessDenied" }],
        });
      }

      const deletion = createStore().get(deleteS3Objects(bucket, keys));
      if (failure === "request rejection") {
        await expect(deletion).rejects.toBe(providerError);
      } else {
        await expect(deletion).rejects.toThrow(
          "S3 object deletion failed for 1 object(s)",
        );
      }
      expect(
        deleteRequests().map((request) => {
          return request.Delete?.Objects?.length;
        }),
      ).toStrictEqual([1000, 1000]);
    },
  );

  it("can retry the same list after earlier batches and part of a later batch succeeded", async () => {
    const keys = objectKeys(2501);
    const remaining = new Set(keys);
    const failedKey = keys[1001];
    let failOnce = true;
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      if (!(request instanceof DeleteObjectsCommand)) {
        throw new Error("Expected an S3 DeleteObjects request");
      }
      const Deleted: { Key: string }[] = [];
      const Errors: { Key: string; Code: string }[] = [];
      for (const object of request.input.Delete?.Objects ?? []) {
        if (object.Key === undefined) {
          throw new Error("Expected an S3 object key");
        }
        if (object.Key === failedKey && failOnce) {
          failOnce = false;
          Errors.push({ Key: object.Key, Code: "InternalError" });
        } else {
          remaining.delete(object.Key);
          // S3 also reports a missing key as successfully deleted.
          Deleted.push({ Key: object.Key });
        }
      }
      return Promise.resolve({ Deleted, Errors });
    });

    const store = createStore();
    await expect(store.get(deleteS3Objects(bucket, keys))).rejects.toThrow(
      "S3 object deletion failed for 1 object(s)",
    );
    expect(remaining).toStrictEqual(new Set([failedKey, ...keys.slice(2000)]));

    await expect(
      store.get(deleteS3Objects(bucket, keys)),
    ).resolves.toBeUndefined();
    expect(remaining.size).toBe(0);
    expect(
      deleteRequests().map((request) => {
        return request.Delete?.Objects?.length;
      }),
    ).toStrictEqual([1000, 1000, 1000, 1000, 501]);
  });
});
