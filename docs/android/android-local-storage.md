# Android Local Storage

Choose storage by the source of truth, the required lifetime, and how the data
can be recovered. Resolve paths through Android `Context` APIs. App-private
internal storage requires no storage permission and is removed on uninstall.
[Android app-specific storage](https://developer.android.com/training/data-storage/app-specific)

## Storage and lifetime

| Data                                                      | Storage and owner                                                                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transient UI state, such as selection and scroll position | Use native state holders and the existing saved-state boundary for bounded recreation metadata.                                                    |
| Small device-local preferences                            | Use Preferences DataStore for key-value data. Keep one process-owned instance per file. Store installation-only preferences in `noBackupFilesDir`. |
| Structured, server-confirmed chat data                    | Use the application-owned Room database under `noBackupFilesDir`. The backend remains authoritative.                                               |
| User-authored drafts or unresolved operations             | Use a separate durable store under `noBackupFilesDir`, with explicit versioning and recovery. Existing small journals use atomic files.            |
| Disposable download and upload staging                    | Use `cacheDir`. Treat eviction as part of the contract.                                                                                            |
| Credentials and application cryptographic keys            | Use the authentication SDK for credentials and Android Keystore for app-owned keys.                                                                |
| User-selected imports, exports, and shared files          | Use the Storage Access Framework or MediaStore as appropriate. Share with content URIs and scoped grants.                                          |

DataStore fits small preference datasets and commits changes transactionally.
Choose Room for structured data that requires partial updates or referential
integrity. Do not create new app-owned `SharedPreferences` stores for preferences.
Canonical member preferences remain server-owned.
[Android DataStore](https://developer.android.com/topic/libraries/architecture/datastore),
[Android Room](https://developer.android.com/training/data-storage/room)

Okou excludes app data from Android cloud backup and device transfer through its
manifest and extraction rules. Keep installation-only data in
`noBackupFilesDir` so its placement also expresses that lifetime. These files
survive normal app restarts and updates. Clearing app data or uninstalling removes
them. Evaluate cloud backup and device transfer separately when changing the
backup policy.
[Android Auto Backup](https://developer.android.com/identity/data/autobackup)

## Identity and access

Use `WorkspaceIdentity.workspaceStorageKey()` for workspace-local persistence.
It derives the stable key from the canonical API address, account ID, and
workspace ID. Session renewal and signing back into the same account preserve
that key. Revalidate workspace authorization before restoring protected content
and retire stale publication. A key locates the data and conveys no access.

Retire workspace consumers and cancel their work when the authorized workspace
closes. Keep process-owned storage available for other consumers. Do physical
file or database cleanup off Main.

## Reads, writes, and recovery

- Keep blocking IO off Main. Observe storage asynchronously so unrelated content
  can render. Model loading, confirmed values, and failures explicitly when they
  affect presentation.
- Update related values in one transaction. A saved preference resolves from
  committed data. When a write completes before its result reaches the consumer,
  preserve the pending intent until confirmation. Surface storage failures with
  the feature's recovery path and keep already confirmed content available.
- Keep confirmed cache records separate from optimistic mutations and temporary
  stream deltas. Recovery can rebuild a server-backed cache. Preserve drafts and
  unresolved operations that cannot be reconstructed from the server.
- Treat filenames, scoped keys, and encodings as persistence contracts. When
  changing them, define how existing installations read or migrate their data.
  Test reopening actual storage, identity isolation, and affected failure paths.

For chat caches, follow Web's snapshot, event replay, cursor, and consistency
semantics. Keep one lazy Room database per process and edit related rows in a
transaction. Store snapshots as per-entity rows so tail appends avoid rewriting
an archive. Use the AndroidX bundled SQLite driver to avoid CursorWindow's
per-row limit, and export Room schemas through its Gradle plugin. Read canonical
data with streaming and cursor-progress checks so native decoding handles the
same legitimate records as Web. Tests must close or checkpoint SQLite before
copying or restoring its files.
