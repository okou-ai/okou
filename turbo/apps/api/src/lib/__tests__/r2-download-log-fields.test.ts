import { describe, expect, it } from "vitest";

import {
  r2DownloadArgumentLogFields,
  r2DownloadErrorLogFields,
} from "@okouai/core/log-utils";
import { withR2DownloadLogFields } from "../r2-download-log-fields";

// Logger-support exception: HTTP callers cannot construct or inspect SDK object
// identity, frozen descriptors, reused errors, or hostile JavaScript arguments.
// Exercise that boundary directly so optional diagnostics cannot change values,
// error propagation, or error ownership.
describe("R2 download log fields", () => {
  const fields = {
    r2_bucket: "example-bucket",
    r2_key: "prefix/archive.tar.gz",
  };
  it("preserves successful values without a download log or error context", async () => {
    const value = { bytes: Buffer.from("body") };
    await expect(
      withR2DownloadLogFields(Promise.resolve(value), fields),
    ).resolves.toBe(value);
    expect(r2DownloadErrorLogFields(value)).toBeUndefined();
  });

  it("preserves the exact frozen error and its provider classification", async () => {
    const error = Object.freeze(
      Object.assign(new Error("provider failure"), { code: "ECONNRESET" }),
    );
    const descriptors = Object.getOwnPropertyDescriptors(error);
    await expect(
      withR2DownloadLogFields(Promise.reject(error), fields),
    ).rejects.toBe(error);
    expect(Object.getOwnPropertyDescriptors(error)).toStrictEqual(descriptors);
    expect(r2DownloadErrorLogFields(error)).toStrictEqual(fields);
    expect(
      r2DownloadArgumentLogFields(["existing message", { error }]),
    ).toStrictEqual(fields);
    expect(r2DownloadArgumentLogFields([error])).toStrictEqual(fields);
    expect(r2DownloadErrorLogFields(new Error("unrelated"))).toBeUndefined();
  });

  it("bounds authoritative keys by UTF-8 bytes and omits oversized identities", async () => {
    const exact = new Error("exact");
    const oversized = new Error("oversized");
    await expect(
      withR2DownloadLogFields(Promise.reject(exact), {
        ...fields,
        r2_key: "k".repeat(1024),
      }),
    ).rejects.toBe(exact);
    expect(r2DownloadErrorLogFields(exact)?.r2_key).toHaveLength(1024);
    await expect(
      withR2DownloadLogFields(Promise.reject(oversized), {
        ...fields,
        r2_key: "界".repeat(342),
      }),
    ).rejects.toBe(oversized);
    expect(r2DownloadErrorLogFields(oversized)).toBeUndefined();
  });

  it("keeps simultaneous failures isolated and omits ambiguous reused errors", async () => {
    const first = new Error("first");
    const second = new Error("second");
    const other = { ...fields, r2_key: "other/object.txt" };
    await Promise.allSettled([
      withR2DownloadLogFields(Promise.reject(first), fields),
      withR2DownloadLogFields(Promise.reject(second), other),
    ]);
    expect(r2DownloadErrorLogFields(first)).toStrictEqual(fields);
    expect(r2DownloadErrorLogFields(second)).toStrictEqual(other);
    await expect(
      withR2DownloadLogFields(Promise.reject(first), other),
    ).rejects.toBe(first);
    expect(r2DownloadErrorLogFields(first)).toBeUndefined();
    await expect(
      withR2DownloadLogFields(Promise.reject(first), fields),
    ).rejects.toBe(first);
    expect(r2DownloadErrorLogFields(first)).toBeUndefined();
  });

  it("skips primitive context and getters and tolerates failing proxy traps", () => {
    expect(r2DownloadErrorLogFields("failure")).toBeUndefined();
    const getter = {
      get error(): never {
        throw new Error("getter must not run");
      },
    };
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(): never {
          throw new Error("trap");
        },
      },
    );
    expect(r2DownloadArgumentLogFields([getter, proxy, null])).toBeUndefined();
  });
});
