# execution-storage-url-freshness

## execution-storage-url-freshness-001

- Vitest: "Execution Storage URL freshness > refreshes a queued mount across the cache margin and publishes the winning URL"
- Mode: run
- Given: A member has published a Memory archive and a settled Run has cached its signed URL. A later Run is queued one minute before the 44-hour refresh threshold for the 48-hour URL cache.
- When: The Run launches one minute after the margin, and the Runner reads its execution. The member then starts another execution.
- Then: The dispatched Memory keeps the version, writeback and archive metadata but carries a fresh URL. The next execution reuses that same Memory payload.

## execution-storage-url-freshness-002

- Vitest: "Execution Storage URL freshness > dispatches the picked Memory archive when HEAD changes during signing"
- Mode: run
- Given: A Runner has cached the first Memory version. Signing a fresh URL for that version is held past the refresh margin. A writer can still publish a newer Memory archive.
- When: A Run starts and picks the first archive, then the writer publishes a second version while signing is held. The signer completes, and a later Run requests Memory.
- Then: The first dispatched execution retains the chosen version and archive metadata, with a fresh URL identifying its original archive. The later execution receives the second version.
