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

## Replacement viewer

- `014` waits for the replacement socket to be created and held with the
  live canvas concealed. The production viewer sends the new measured
  720×480 size after the fixture releases the socket.
- `016` holds the old native text receipt through a runtime identity change
  on the same CDP endpoint. It compares the receiving session IDs and the
  rendered replacement address.
- `017` and `018` are two expanded window-zero rows. With either provider
  URL, a new runtime's held socket disables input, and the current page
  receives the fresh text once the replacement returns. Revalidating the
  unchanged runtime kept one socket, so that probe could not exercise
  the replacement premise.

Fourteen expanded runtime rows now match fourteen selected IDs.

## Restart and lease recovery

- `022` enters a composing address draft while stopped, restarts using the
  native open contract, and submits a Google search by keyboard.
- `038` and `045` use an explicit retry gate after a 503. The two retries
  confirm expiry via a suspended-session response and a 404, respectively.
  In both cases the current presentation is confirmed as suspended.
- `039` observes a logged HTTP 502 and waits for another renewal after
  the successful retry. The native viewer remains live and address remains editable.
- `050` holds the initial renewal and returns the reopened window in its
  response. The viewer shows the replacement tab and renews again.

Nineteen expanded rows now match nineteen selected IDs. The BDD remains
for the nine unchecked cases. In particular, `024` and `025` describe
separate session and native connection reads alongside an outstanding lease
on initial page open. The current GET performs combined native acquisition,
and keep-alive mounts only after an active presentation is loaded. An initial
authorization denial cannot currently construct either pending-lease Given
through the standalone route.

## Overlapping renewals and navigation

- `023` holds native membership checks across two authority scopes. It
  observes the first blocked hint, then verifies that the second attempt
  shows a new hint only until its check completes. No navigation reaches CDP.
- `035` holds both lease responses and proves that the renewed grant starts
  renewing before the older lease completes. Its own denied renewal removes
  input. `036` releases an older denial during the new socket's load and
  verifies that the renewed viewer streams. `037` restores the viewer after
  delivering revoke and grant events together against a cached enabled grant.
- `053` holds a late renewal during native instance replacement and confirms
  the later viewer renews, accepts address editing and records one heartbeat
  failure. `055` observes the old request's abort signal when the Router
  switches chats and verifies that subsequent renewal requests use the new ID.

Twenty-five expanded rows match twenty-five selected IDs. The BDD stays for
`024`, `025` and `034`. An in-place same-window reload in `034` preserves
the mounted active panel and its keep-alive ref. The lease loop awaits the
active HTTP round before requesting another lease. The frozen ordering, with
the new lease already pending when the old one returns its denial, requires
a refresh that starts a second renewal owner. The grant-change and route
replacement cases above provide such a boundary and are tracked separately.
