# Standalone browser page rebuild

The merge through main `3384e0bf` changes the runner MITM addon and adds no
Platform registrations. The frozen selection is unchanged.

- `004` checks the native capture request and numeric field through IME,
  Enter, and blur.
- `006` checks all three presets, slider keyboard endpoints, and focus return
  after each Escape. `007` and `008` drive the real slider against fixed
  layout geometry and verify the capture boundary on release and dismissal.
- `009` checks the native capture format, the disabled lossless quality
  control, and JPEG quality and selection after reopening.
- `010` exercises the combined native acquisition route's typed
  `409 BROWSER_RECLAIMING` response. The exploratory active presentation
  with a null native viewer did not show the required placeholder.
  The API returns the reclaiming error when active presentation has no CDP URL.
- `028` holds the initial lease response while the viewer streams, then returns
  authorization denial with the fixture's subsequent reads reflecting the
  revoked grant. The test never supplies a socket disconnect event.
- `032` delivers grant and revocation through canonical thread events and
  observes the viewer stream and then remove remote input.

The ten runtime executions match ten selected IDs in both directions.
Eighteen selected cases are still open. Retain the file's BDD. Continue with
`014`, `016`–`018` for replacement viewer measurements and authority,
then the remaining lease and authorization cases.
