import { describe, expect, it } from "vitest";

import {
  computeContentHashFromHashes,
  type FileEntryWithHash,
} from "../storage-content-hash";
import contentHashContract from "./fixtures/storage-content-hash.json";

interface ContentHashFixture {
  readonly name: string;
  readonly storageId: string;
  readonly files: readonly FileEntryWithHash[];
  readonly expected: string;
}

const fixtures: readonly ContentHashFixture[] = contentHashContract;

describe("storage content hash contract", () => {
  it.each(fixtures)("$name", ({ storageId, files, expected }) => {
    expect(computeContentHashFromHashes(storageId, files)).toBe(expected);
  });
});
