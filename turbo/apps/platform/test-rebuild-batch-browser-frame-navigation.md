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
