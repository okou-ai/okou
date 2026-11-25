# tar

## tar-001

- Vitest: "TAR extraction > accepts a canonical empty archive"
- Mode: run
- Intent: review
- Given: A gzip-compressed TAR contains exactly two 512-byte zero blocks.
- When: A consumer extracts the regular files.
- Then: The result is an empty list.

## tar-002

- Vitest: "TAR extraction > rejects an incomplete empty archive"
- Mode: run
- Intent: review
- Given: A gzip-compressed TAR contains only one 512-byte zero block.
- When: A consumer extracts the regular files.
- Then: Extraction throws an error containing `TAR_BAD_ARCHIVE`.

## tar-003

- Vitest: "TAR extraction > keeps hiding nonregular entries from the file extractors"
- Mode: run
- Intent: review
- Given: The archive has a regular `SKILL.md` containing `real`, a symlink with the same name and a `docs` directory.
- When: A consumer extracts `SKILL.md` as a regular file with a 1 MiB output ceiling.
- Then: It obtains exactly one file at `SKILL.md` containing `real`.

## tar-004

- Vitest: "TAR target occurrences > reports every claim on a target path, nonregular ones included"
- Mode: run
- Intent: review
- Given: The archive has a regular `CLAUDE.md` containing `real`, a symlink with the same name and a separate regular `OTHER.md`.
- When: A consumer asks for all occurrences of `CLAUDE.md` with a 1 MiB output ceiling.
- Then: The result contains two occurrences of `CLAUDE.md` in archive order. The first contains `real` and the second has null content.

## tar-005

- Vitest: "TAR target occurrences > reports a directory claiming the target without reading anything"
- Mode: run
- Intent: review
- Given: The archive has a directory entry named `CLAUDE.md`.
- When: A consumer asks for occurrences of `CLAUDE.md` with a 1 MiB output ceiling.
- Then: The result contains one occurrence at `CLAUDE.md` with null content.

## tar-006

- Vitest: "TAR target occurrences > normalizes a leading ./ the way the extractors do"
- Mode: run
- Intent: review
- Given: The archive has a regular file at `./CLAUDE.md` containing `real`.
- When: A consumer asks for occurrences of `CLAUDE.md` with a 1 MiB output ceiling.
- Then: The result contains one occurrence under the normalized path `CLAUDE.md` with content `real`.

## tar-007

- Vitest: "TAR target occurrences > refuses to decompress past the ceiling it was given"
- Mode: run
- Intent: review
- Given: A gzip-compressed archive contains a regular `CLAUDE.md` with 4,096 bytes of content.
- When: A consumer asks for occurrences of `CLAUDE.md` with a 1,024-byte decompression ceiling.
- Then: Extraction throws with error code `ERR_BUFFER_TOO_LARGE`.
