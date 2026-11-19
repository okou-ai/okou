# Browser frame window and navigation rebuild

- Frame window 01.01, 02, 03, and 05 verify the three short RTT samples,
  a stalled or rejected optional probe, and the split socket's own 200 ms
  samples. The fixture exposes actual canvas draws and accounts for outstanding
  frame ACKs. The split case waits for a fresh paint before counting the
  eight-frame window; the old control session is not the capture session.
- Navigation regression 02, 04.01, 05, and 06 verify held initial history,
  reload failure recovery, a download acknowledgement without usable
  history, and a redirect whose final target commits before its receipt.

Main `1e7094d1` changes the For you direction editor and does not add tests.
The existing For you file is checked against the revised editor. The three
standalone browser page blockers remain documented in the prior batch.

## Touch, diagnostics, and pointer recovery

- Touch regression 01, 03.01, 04, 05, and 07 cover release coordinates with
  compatibility mouse events, cancelled gestures, letterboxing, tab changes,
  and desktop click and wheel ordering.
- Connection diagnostics 01, 02, 03, 05.03, and 06 verify bridge startup
  reporting, quiet revalidation and background lookup, and sanitized native
  navigation failures. The page fixture serves a healthy local status
  response so unrelated status-service failures do not pollute the report
  assertions.
- Pointer recovery 002, 005, 007, and 008 verify no hover replay on a sibling
  and preservation of drag, key release, and earlier native rejection
  diagnostics. The key release may fail at the retired session boundary
  before a key-up reaches the wire. The two hover receipts in 008 are held
  independently; the earlier rejection arrives before the later detach.

All 22 selected runtime rows match their five files' frozen IDs in both
directions. The five BDD files are removed. For you's 19 existing rows
passed against `1e7094d1`. Standalone browser page 024, 025, and 034 retain
their original BDD and separate evidence.
