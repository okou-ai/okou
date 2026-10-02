import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { Header } from "tar";
import { describe, expect, it } from "vitest";

import {
  piResourceIndexFits,
  preparePiResourceIndex,
  RESOURCE_ARCHIVE_MAX_BYTES,
} from "../pi-resource-index";

function archive(
  files: readonly { readonly path: string; readonly content: Buffer }[],
) {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    new Header({
      path: file.path,
      size: file.content.length,
      type: "File",
      mode: 0o644,
    }).encode(header);
    chunks.push(
      header,
      file.content,
      Buffer.alloc((512 - (file.content.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

// These byte-level inputs are the archive decoder's contract. Workflow APIs cap
// attachments at 5 MiB and cannot express binary payloads or 32/64 MiB archives.
// Use actual gzip/tar bytes and real decoding, never mock internal functions.
describe("Pi resource archive preparation bounds", () => {
  it("retains ordered duplicate discovery text and adjacent binary paths", () => {
    const bytes = archive([
      { path: "./AGENTS.md", content: Buffer.from("First instructions") },
      { path: "AGENTS.md", content: Buffer.from("Last instructions: 世界") },
      {
        path: "skills/report/SKILL.md",
        content: Buffer.from(
          "---\nname: report\ndescription: Read the report.\ndisable-model-invocation: true\n---\nBody stays in Storage.\n",
        ),
      },
      {
        path: "skills/report/icon.png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]),
      },
    ]);
    expect(preparePiResourceIndex(bytes)).toStrictEqual({
      schemaVersion: 1,
      files: [
        {
          path: "AGENTS.md",
          text: { kind: "text", value: "First instructions" },
          skill: { kind: "skill" },
        },
        {
          path: "AGENTS.md",
          text: { kind: "text", value: "Last instructions: 世界" },
          skill: { kind: "skill" },
        },
        {
          path: "skills/report/SKILL.md",
          skill: {
            kind: "skill",
            name: "report",
            description: "Read the report.",
            disableModelInvocation: true,
          },
        },
        { path: "skills/report/icon.png" },
      ],
    });
  });

  it("does not prepare a valid archive larger than the compressed limit", () => {
    const bytes = archive([
      {
        path: "asset.bin",
        content: randomBytes(RESOURCE_ARCHIVE_MAX_BYTES + 1024),
      },
    ]);
    expect(bytes.length).toBeGreaterThan(RESOURCE_ARCHIVE_MAX_BYTES);
    expect(preparePiResourceIndex(bytes)).toBeUndefined();
  });

  it("does not prepare a small compressed archive exceeding the expanded limit", () => {
    const bytes = archive([
      { path: "asset.bin", content: Buffer.alloc(64 * 1024 * 1024) },
    ]);
    expect(bytes.length).toBeLessThan(RESOURCE_ARCHIVE_MAX_BYTES);
    expect(preparePiResourceIndex(bytes)).toBeUndefined();
  });

  it("keeps file-count and serialized projection bounds independent of archive validity", () => {
    const emptyFiles = Array.from({ length: 100_001 }, () => {
      return { path: "empty.txt" };
    });
    expect(
      piResourceIndexFits({ schemaVersion: 1, files: emptyFiles }),
    ).toBeFalsy();
    expect(
      piResourceIndexFits({ schemaVersion: 1, files: emptyFiles.slice(1) }),
    ).toBeTruthy();
    expect(
      piResourceIndexFits({
        schemaVersion: 1,
        files: [
          {
            path: "AGENTS.md",
            text: { kind: "text", value: "x".repeat(16 * 1024 * 1024) },
          },
        ],
      }),
    ).toBeFalsy();
  });
});
