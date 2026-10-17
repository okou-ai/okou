import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { OwnedWssRun, RunnerWssApi } from "./runner-wss-api";

/** Real public TLS -> pinned Caddy -> current Runner -> actual Guest file bytes. */
export async function probeDownloads(
  api: RunnerWssApi,
  run: OwnedWssRun,
  signal: AbortSignal,
) {
  const startRss = process.memoryUsage().rss;
  let peakRss = startRss;
  let chunks = 0;
  const read = async (names: string[], size: number, expected: string) => {
    const url = await api.download(run, names);
    if (size === 0) {
      const head = await fetch(url, {
        method: "HEAD",
        signal,
        redirect: "error",
      });
      try {
        assert.equal(head.status, 405);
      } finally {
        await head.body?.cancel();
      }
      const invalidPath = await fetch(`${url}/extra`, {
        signal,
        redirect: "error",
      });
      try {
        assert.equal(invalidPath.status, 404);
      } finally {
        await invalidPath.body?.cancel();
      }
    }
    const response = await fetch(url, { signal, redirect: "error" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(size));
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment; filename=/,
    );
    assert.equal(
      response.headers.get("cache-control"),
      "no-store, no-transform",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("accept-ranges"), "none");
    assert.ok(response.body);
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let count = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        hash.update(chunk.value);
        count += chunk.value.length;
        chunks += 1;
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        // Exercise actual TLS backpressure while retaining only one chunk.
        if (size > 1024 * 1024 && count === chunk.value.length)
          await delay(300, undefined, { signal });
      }
    } finally {
      await reader.cancel();
    }
    assert.equal(count, size);
    assert.equal(hash.digest("hex"), expected);
    const replay = await fetch(url, { signal, redirect: "error" });
    try {
      assert.ok([404, 503].includes(replay.status));
    } finally {
      await replay.body?.cancel();
    }
  };
  await read([".hidden"], 0, createHash("sha256").digest("hex"));
  await read(
    ["nested", "leaf"],
    70003,
    createHash("sha256")
      .update(Uint8Array.from({ length: 70003 }, (_, i) => i % 256))
      .digest("hex"),
  );
  const expected = createHash("sha256");
  const zeroChunk = Buffer.alloc(65536);
  for (let i = 0; i < 2048; i++) expected.update(zeroChunk);
  await read(["file-0"], 134217728, expected.digest("hex"));
  return {
    nativeDownloadBytes: 134287731,
    nativeDownloadChunks: chunks,
    nativeDownloadHashes: "PASS",
    nativeDownloadReplay: "rejected",
    nativeDownloadMethodAndPath: "rejected",
    downloadClientStartRss: startRss,
    downloadClientPeakRss: peakRss,
  };
}

export async function probeDownloadRunEnd(
  api: RunnerWssApi,
  run: OwnedWssRun,
  signal: AbortSignal,
) {
  const response = await fetch(await api.download(run, ["file-0"]), {
    signal,
    redirect: "error",
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  let count = 0;
  let interrupted = false;
  try {
    const first = await reader.read();
    assert.ok(!first.done);
    count += first.value.length;
    await api.cancel(run);
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        count += chunk.value.length;
      }
    } catch {
      interrupted = true;
    }
    assert.ok(
      interrupted && count < 134217728,
      "Run end must fail the incomplete HTTP body",
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
  return {
    nativeDownloadRunEnd: "interrupted",
    nativeDownloadInterruptedBytes: count,
  };
}
