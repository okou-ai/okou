import { createHash } from "node:crypto";

const PI_MEMORY_PHASE2_SELECTION_ENCODING = "vm0.pi-memory.phase2.selection.v1";

function uint32Buffer(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

export function piMemoryPhase2SelectionDigest(
  selected: readonly {
    readonly piSessionId: string;
    readonly sourceHistoryHash: string;
  }[],
): string {
  const version = Buffer.from(PI_MEMORY_PHASE2_SELECTION_ENCODING, "utf8");
  const parts: Buffer[] = [
    uint32Buffer(version.length),
    version,
    uint32Buffer(selected.length),
  ];
  for (const candidate of selected) {
    const piSessionId = Buffer.from(candidate.piSessionId, "utf8");
    const sourceHistoryHash = Buffer.from(candidate.sourceHistoryHash, "utf8");
    parts.push(
      uint32Buffer(piSessionId.length),
      piSessionId,
      uint32Buffer(sourceHistoryHash.length),
      sourceHistoryHash,
    );
  }
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex");
}
