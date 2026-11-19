# Chat follow-up and browser viewer rebuild

Main `4338aeea` retires the pre-draft API rollback scenario. See the
[upstream reconciliation](test-rebuild-upstream-4338aeea.md) and the
[For you selection](test-rebuild-upstream-8ee03b20.md).

## Verified and cleaned

- MCP expected failures 001 and 002 keep the correct user guidance and retry
  behavior. Both cases verify no exception via the existing Sentry SDK mock
  after the popup closes and retry is available. The two runtime rows account
  for both selected IDs out of four frozen rows.
- Mail feedback 001 reproduces the quote and comment from an opened Gmail
  draft. The send carries the draft ID and status, and the transcript displays
  the source label. One runtime row accounts for the sole frozen row.

- Header loading 002, 005, 007 and 008 cover both empty states, focusable
  busy actions while a destination metadata read is held, the destination
  browser on mobile, and each split pane's own mail list. Four runtime rows
  account for the four selected IDs out of eight frozen rows.

## Additional verified scenarios in files with open requirements

- Browser actions 002 uses the message-port transport so the named Ably
  subscription gate can delay attachment. Then it verifies suspension and
  thumbnail changes and a continuity-gap refresh. Browser actions 003 and
  005 cover the stopped panel and live native viewer suspension and recovery.
  All 13 selected IDs now have runtime rows, with one unverified CSS Then
  in 001. The original BDD remains.
- Mail 003 sends and revisits the approval draft, then deletes the separate
  vendor draft through the live Chat UI with typed, stateful mail responses.

## BDD retained

| File or stable ID             | Given, When or Then still open and evidence                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser actions 001           | Happy DOM verifies card labels and thumbnail. Border width, line height, and actual transition properties still need a CSS-rendering boundary.                                                                                                                                                                                                                                            |
| Chat scroll 005               | The reader opens Automations while reading history, receives a reply behind it, then closes the sidebar. With the incoming reply rendered before reveal, one run observed a matching anchor and one scroll write, while another observed two writes `[20, 500]`. The exact-once assertion stays open.                                                                                     |
| Chat scroll 006, 008, 016–019 | Side-thread Router handoff, pending Mermaid render, PWA keyboard viewport cycles, and resize during capability transitions still need their respective fixture and synchronization work.                                                                                                                                                                                                  |
| Unified workspace 005–006     | Widths and fold state must survive reload. Replacing the page via `createTestRuntime` with real Router bootstrap hit `AbortError: signal is aborted without reason` in both cases. The child's disposal also calls `resetLocalStorageForTest$`, which removes registered keys. The browser-backed reload or a harness that preserves browser storage across app disposal is still needed. |
| Voice recording 004–005       | Restored recordings with 128 and 129 completed segments must polish into 128 and 65 items without retranscribing. The workspace reload probe does not establish a supported browser-document replacement.                                                                                                                                                                                 |
| Voice incremental 003         | A 502 configuration error shows feedback and preserves the removable draft. The Sentry SDK mock recorded no exception after the expected UI state, so the required report with status and code is still unverified.                                                                                                                                                                       |
| Voice isolation 001–002       | Held VAD completion and failed-draft restoration must be checked across distinct identities. The 002 probe produced a failed, removable draft through the UI. Disposing its child runtime and bootstrapping a fresh identity rejected with the supplied AbortError before the replacement composer became ready. The VAD release scenario 001 remains open.                               |
| Mail 002, 005                 | Trusted-link variants must preserve their labels and routing, and the complete mail detail must verify sanitization and both attachment previews.                                                                                                                                                                                                                                         |
| Browser session page          | 002 verifies the three native window-size settings and 003 verifies switching between a blank tab and Example. The remaining selected browser page scenarios still need individual review and execution.                                                                                                                                                                                  |
