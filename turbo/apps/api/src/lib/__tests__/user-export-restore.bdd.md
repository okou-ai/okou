# user-export-restore

## user-export-restore-001

- Vitest: "downloaded export recovery tool > restores verified paged sources, current chat events, instructions and guest binary memory"
- Mode: run
- Intent: review
- Given: A downloaded export contains verified paged source manifests, a chat snapshot and tail, a pinned thread, a personal instruction and a Workflow instruction. Its binary memory comes from the guest writer.
- When: The user runs the archive recovery CLI against the downloaded export.
- Then: It exits 0 with empty stderr. The restored thread contains events 3, 5, 8, 9 and 10 in order, and the empty thread stays empty. The restored binary file is byte-identical, and the corresponding exports contain the personal instruction, Workflow instruction and pinned thread.

## user-export-restore-002

- Vitest: "downloaded export recovery tool > restores verified paged sources, current chat events, instructions and server binary memory"
- Mode: run
- Intent: review
- Given: A downloaded export contains verified paged source manifests, a chat snapshot and tail, a pinned thread, a personal instruction and a Workflow instruction. Its binary memory comes from the server writer.
- When: The user runs the archive recovery CLI against the downloaded export.
- Then: It exits 0 with empty stderr. The restored thread contains events 3, 5, 8, 9 and 10 in order, and the empty thread stays empty. The restored binary file is byte-identical, and the corresponding exports contain the personal instruction, Workflow instruction and pinned thread.

## user-export-restore-003

- Vitest: "downloaded export recovery tool > rejects a supplied memory fileCount that disagrees with the file inventory"
- Mode: run
- Intent: review
- Given: The downloaded export contains a memory manifest whose file count disagrees with its listed files.
- When: The user runs the archive recovery CLI.
- Then: It exits 1 with `Memory manifest totals do not match its files` on stderr. No chat thread output exists.

## user-export-restore-004

- Vitest: "downloaded export recovery tool > rejects a supplied memory totalSize that disagrees with the file inventory"
- Mode: run
- Intent: review
- Given: The downloaded export contains a memory manifest whose total byte size disagrees with its listed files.
- When: The user runs the archive recovery CLI.
- Then: It exits 1 with `Memory manifest totals do not match its files` on stderr. No chat thread output exists.

## user-export-restore-005

- Vitest: "downloaded export recovery tool > raises the thread bound to a snapshot that overtook it mid-export"
- Mode: run
- Intent: review
- Given: The downloaded export records a thread boundary of event 10 and includes a snapshot written during export that covers events through 12.
- When: The user runs the archive recovery CLI.
- Then: It exits 0 with empty stderr and restores exactly events 3, 5, 8, 9 and 12. The later snapshot supersedes the tail at or below its own boundary.

## user-export-restore-006

- Vitest: "downloaded export recovery tool > rejects changed source bytes even when their ZIP CRC is internally valid"
- Mode: run
- Intent: review
- Given: A workflow source entry changed after the archive's source manifest was recorded. The ZIP CRC was recalculated for the changed bytes.
- When: The user runs the archive recovery CLI.
- Then: It exits 1 with a SHA-256 mismatch on stderr and creates no workflow output file.

## user-export-restore-007

- Vitest: "downloaded export recovery tool > verifies the concatenated manifest page digest before trusting its file checksums"
- Mode: run
- Intent: review
- Given: A later export manifest page names an altered path and therefore disagrees with the recorded digest.
- When: The user runs the archive recovery CLI.
- Then: It exits 1 and reports `Manifest page SHA-256 mismatch` on stderr.

## user-export-restore-008

- Vitest: "downloaded export recovery tool > refuses memory archive links without creating output files"
- Mode: run
- Intent: review
- Given: The memory TAR in a downloaded export contains a symbolic link and its file inventory is empty.
- When: The user runs the archive recovery CLI.
- Then: It exits 1, reports a link or special file, and creates no chat thread output file.

## user-export-restore-009

- Vitest: "downloaded export recovery tool > refuses a memory manifest path that escapes the restored directory"
- Mode: run
- Intent: review
- Given: The memory manifest lists a path that resolves outside the restore directory.
- When: The user runs the archive recovery CLI.
- Then: It exits 1, reports `Unsafe archive path`, and creates no chat thread output file.

## user-export-restore-010

- Vitest: "downloaded export recovery tool > refuses ZIP link metadata before processing its contents"
- Mode: run
- Intent: review
- Given: The ZIP metadata marks a workflow source entry as a symbolic link.
- When: The user runs the archive recovery CLI.
- Then: It exits 1 and reports `ZIP contains a link` on stderr.
