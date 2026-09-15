import { describe, expect, it } from "vitest";

import { piMemoryPhase2SelectionDigest } from "./phase2-memory-selection";

describe("Pi memory Phase 2 selection encoding", () => {
  // Fixed SHA-256 goldens from an independent uint32-BE/UTF-8 encoder.
  // Candidate order is part of the persisted selection identity.
  const ascii = { piSessionId: "session-a", sourceHistoryHash: "a".repeat(64) };
  const unicode = { piSessionId: "会话🌍", sourceHistoryHash: "b".repeat(64) };

  it.each([
    {
      selected: [],
      digest:
        "f95c6835f8a93234e88b26bc2162bd3cf8defd709037f6eefb14ee6ae3d56e48",
    },
    {
      selected: [ascii],
      digest:
        "24a9bc5c377eb5bfc66e9976218eb1c99ecb6461e2593788b2c752f4437288b2",
    },
    {
      selected: [unicode, ascii],
      digest:
        "fff7703ac79540a658abc4e86f142eb613ed032e3b6d4e5213e785a609c0a49e",
    },
    {
      selected: [ascii, unicode],
      digest:
        "b92a462101eb3be1031b959963a8c67f1f2f18240ee5f72ec48e3bbba1b01735",
    },
  ])("preserves the $digest selection identity", ({ selected, digest }) => {
    expect(piMemoryPhase2SelectionDigest(selected)).toBe(digest);
  });
});
