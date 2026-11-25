# user-export-zip

## user-export-zip-001

- Vitest: "resumable user export ZIP format > recreates the same valid ZIP when ranges are assembled across source and header boundaries"
- Mode: run
- Intent: review
- Given: An export has a JSONL file, a binary memory file with a Unicode path and an empty chat message file. Source chunks can be empty.
- When: An export consumer reads the full archive and also assembles 37-byte archive ranges, regenerating one completed range.
- Then: The regenerated range is identical and the assembled bytes equal the full archive. An ordinary ZIP reader lists the input paths in order, reads their exact bytes and reports stored method 0 for each entry.

## user-export-zip-002

- Vitest: "resumable user export ZIP format > serializes an empty archive that ordinary ZIP readers open"
- Mode: run
- Intent: review
- Given: An export has zero entries and an empty central directory at offset zero.
- When: The ZIP end record is generated and opened in a ZIP reader.
- Then: The archive opens with an empty entry list.

## user-export-zip-003

- Vitest: "resumable user export ZIP format > resumes CRC32 from its persisted unsigned value"
- Mode: run
- Intent: review
- Given: CRC32 has been updated with bytes `1234` and persisted as a JSON number.
- When: The exporter restores that checkpoint and processes bytes `56789`.
- Then: The final CRC32 is `0xCBF43926`.

## user-export-zip-004

- Vitest: "resumable user export ZIP format > uses ZIP64 size and offset fields exactly at legacy sentinel values"
- Mode: run
- Intent: review
- Given: A stored ZIP entry has size `0xFFFFFFFF` and local-header offset `0xFFFFFFFF + 123`.
- When: The exporter serializes the local and central headers.
- Then: Both lengths match the entry layout. The local header requires version 45 and uses the 32-bit size sentinel. The central header uses the 32-bit offset sentinel. Both carry ZIP64 extras with both exact sizes, and the central extra also carries the exact offset.

## user-export-zip-005

- Vitest: "resumable user export ZIP format > keeps ZIP64 offset-only extras in their specified position"
- Mode: run
- Intent: review
- Given: A 42-byte entry starts at local-header offset `0xFFFFFFFF`.
- When: The exporter serializes the central header.
- Then: The ordinary size field remains 42. The ZIP64 extra contains one eight-byte value, the exact local-header offset.

## user-export-zip-006

- Vitest: "resumable user export ZIP format > emits ZIP64 end and locator records for overflowing 65535 entries"
- Mode: run
- Intent: review
- Given: The archive has 65535 entries, central directory offset 500 and central directory size 70.
- When: The export writes the ZIP end and locator records.
- Then: The ZIP64 end contains the exact 64-bit entry count, central directory size and offset. The ZIP64 locator points to the end of the central directory. The regular end-of-central-directory signature follows.

## user-export-zip-007

- Vitest: "resumable user export ZIP format > emits ZIP64 end and locator records for overflowing 1 entries"
- Mode: run
- Intent: review
- Given: The archive has 1 entries, central directory offset 4294967295 and central directory size 70.
- When: The export writes the ZIP end and locator records.
- Then: The ZIP64 end contains the exact 64-bit entry count, central directory size and offset. The ZIP64 locator points to the end of the central directory. The regular end-of-central-directory signature follows.

## user-export-zip-008

- Vitest: "resumable user export ZIP format > emits ZIP64 end and locator records for overflowing 1 entries"
- Mode: run
- Intent: review
- Given: The archive has 1 entries, central directory offset 500 and central directory size 4294967295.
- When: The export writes the ZIP end and locator records.
- Then: The ZIP64 end contains the exact 64-bit entry count, central directory size and offset. The ZIP64 locator points to the end of the central directory. The regular end-of-central-directory signature follows.

## user-export-zip-009

- Vitest: "resumable user export ZIP format > rejects an unsafe archive filename \"\""
- Mode: run
- Intent: review
- Given: The export entry name is empty.
- When: The ZIP writer attempts to serialize the local header.
- Then: It rejects the path as unsafe or invalid as UTF-8.

## user-export-zip-010

- Vitest: "resumable user export ZIP format > rejects an unsafe archive filename \"/absolute\""
- Mode: run
- Intent: review
- Given: The export entry name is an absolute path.
- When: The ZIP writer attempts to serialize the local header.
- Then: It rejects the path as unsafe or invalid as UTF-8.

## user-export-zip-011

- Vitest: "resumable user export ZIP format > rejects an unsafe archive filename \"../escape\""
- Mode: run
- Intent: review
- Given: The export entry name starts with a parent-directory segment.
- When: The ZIP writer attempts to serialize the local header.
- Then: It rejects the path as unsafe or invalid as UTF-8.

## user-export-zip-012

- Vitest: "resumable user export ZIP format > rejects an unsafe archive filename \"a/../b\""
- Mode: run
- Intent: review
- Given: The export entry name contains a parent-directory segment.
- When: The ZIP writer attempts to serialize the local header.
- Then: It rejects the path as unsafe or invalid as UTF-8.

## user-export-zip-013

- Vitest: "resumable user export ZIP format > rejects an unsafe archive filename \"a//b\""
- Mode: run
- Intent: review
- Given: The export entry name contains an empty interior segment.
- When: The ZIP writer attempts to serialize the local header.
- Then: It rejects the path as unsafe or invalid as UTF-8.

## user-export-zip-014

- Vitest: "resumable user export ZIP format > rejects an unsafe archive filename \"a\\\\b\""
- Mode: run
- Intent: review
- Given: The export entry name contains a backslash.
- When: The ZIP writer attempts to serialize the local header.
- Then: It rejects the path as unsafe or invalid as UTF-8.

## user-export-zip-015

- Vitest: "resumable user export ZIP format > rejects an unsafe archive filename \"C:drive\""
- Mode: run
- Intent: review
- Given: The export entry name has a drive prefix.
- When: The ZIP writer attempts to serialize the local header.
- Then: It rejects the path as unsafe or invalid as UTF-8.

## user-export-zip-016

- Vitest: "resumable user export ZIP format > rejects an unsafe archive filename \"nul\\u0000byte\""
- Mode: run
- Intent: review
- Given: The export entry name contains a NUL.
- When: The ZIP writer attempts to serialize the local header.
- Then: It rejects the path as unsafe or invalid as UTF-8.

## user-export-zip-017

- Vitest: "resumable user export ZIP format > rejects an unsafe archive filename \"\\ud800\""
- Mode: run
- Intent: review
- Given: The export entry name contains an unpaired UTF-16 surrogate.
- When: The ZIP writer attempts to serialize the local header.
- Then: It rejects the path as unsafe or invalid as UTF-8.

## user-export-zip-018

- Vitest: "resumable user export ZIP format > rejects a filename larger than the ZIP format allows"
- Mode: run
- Intent: review
- Given: A file path is 65,536 ASCII bytes long.
- When: The ZIP writer attempts to serialize the local header.
- Then: It rejects the path with a message identifying the 65,535 UTF-8 byte limit.

## user-export-zip-019

- Vitest: "resumable user export ZIP format > rejects incomplete or overlapping input instead of uploading corrupt ranges"
- Mode: run
- Intent: review
- Given: A requested ten-byte range has either nine input bytes or two segments that overlap.
- When: The export plans the requested archive range.
- Then: It rejects the first plan as incomplete and the second with a gap-or-overlap error.
