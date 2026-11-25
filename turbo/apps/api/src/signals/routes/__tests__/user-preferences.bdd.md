# user-preferences

## user-preferences-001

- Vitest: "get requires initialization and post returns the saved preferences"
- Mode: run
- Given: A signed-in workspace member has never saved preferences.
- When: The member calls `GET /api/user-preferences`, then `POST /api/user-preferences/initialize` with timezone `Asia/Tokyo` and locale `ja-JP`, reads `GET /api/user-preferences` again, and repeats initialization with `America/Los_Angeles` and `en-US`.
- Then: The first read returns HTTP 409 with error code `USER_PREFERENCES_UNINITIALIZED`. Initialization returns HTTP 200 with `Asia/Tokyo` and `ja-JP`, and the following read returns exactly the same body. The repeated initialization returns HTTP 200 and still reports `Asia/Tokyo` and `ja-JP`.

## user-preferences-002

- Vitest: "initialization fills only a missing locale"
- Mode: run
- Given: A signed-in member has saved only timezone `Asia/Tokyo` via `POST /api/user-preferences`, so preferences remain uninitialized.
- When: The member reads `GET /api/user-preferences`, then calls `POST /api/user-preferences/initialize` with `America/Los_Angeles` and `fr-FR`.
- Then: The read returns HTTP 409. Initialization returns HTTP 200 keeping timezone `Asia/Tokyo` and filling locale `fr-FR`.

## user-preferences-003

- Vitest: "initialization fills only a missing timezone"
- Mode: run
- Given: A signed-in member has saved only locale `de-DE` via `POST /api/user-preferences`, so preferences remain uninitialized.
- When: The member reads `GET /api/user-preferences`, then calls `POST /api/user-preferences/initialize` with `Asia/Tokyo` and `fr-FR`.
- Then: The read returns HTTP 409. Initialization returns HTTP 200 filling timezone `Asia/Tokyo` and keeping locale `de-DE`.

## user-preferences-004

- Vitest: "initialization uses Pacific Time and English when no hints are provided"
- Mode: run
- Given: A signed-in member has never saved preferences.
- When: The member calls `POST /api/user-preferences/initialize` with only locale `en-US` and no timezone, then reads `GET /api/user-preferences`.
- Then: Initialization returns HTTP 200 with timezone `America/Los_Angeles` and locale `en-US`, and the read returns exactly the same body.

## user-preferences-005

- Vitest: "for you covers persist per workspace member and can be reset"
- Mode: run
- Given: A signed-in member initializes preferences in a workspace. Another member of the same workspace and the same user in another workspace also exist.
- When: The member saves `forYouCoverId: "cover-08"` via `POST /api/user-preferences`; the other member and the same user in the other workspace initialize; the original member updates `theme: "dark"` and later saves `forYouCoverId: null`, reading `GET /api/user-preferences` after each change.
- Then: Initialization starts with a null cover, the save and read return `cover-08`, and the other member and other workspace see a null cover. After the theme change the cover is still `cover-08`. After the reset the cover is null and the theme stays `dark`.

## user-preferences-006

- Vitest: "presentation preferences stay null until chosen and survive unrelated updates and initialization"
- Mode: run
- Given: A signed-in member for whom the presentation output format feature is enabled.
- When: The member initializes with locale `en-US`, saves `presentationFormat` `html` then `pptx` via `POST /api/user-preferences`, updates `theme: "dark"`, re-initializes with locale `ja-JP`, and reads `GET /api/user-preferences`.
- Then: Initialization returns a null `presentationFormat`; the saves return `html` then `pptx`. The theme update, the repeated initialization (which keeps locale `en-US`) and the final read all report `pptx`.

## user-preferences-007

- Vitest: "presentation preferences stay isolated between members and workspaces"
- Mode: run
- Given: A signed-in member with the presentation output format feature enabled initializes and saves `presentationFormat: "pptx"` in a staff workspace. Another member of that workspace and the same user in another workspace also exist.
- When: The other member and the other-workspace identity each initialize and save `presentationFormat: "html"`; the original member then reads `GET /api/user-preferences`.
- Then: The other member's and other workspace's initialization each return a null `presentationFormat`. The original member still reads `pptx`.

## user-preferences-008

- Vitest: "saving a presentation preference does not initialize timezone, locale, or memory"
- Mode: run
- Given: A signed-in member with the presentation output format feature enabled has never initialized preferences.
- When: The member saves `presentationFormat: "pptx"` via `POST /api/user-preferences`, reads `GET /api/user-preferences`, then initializes with locale `en-US`.
- Then: The save returns HTTP 200 with `pptx`, null timezone and locale, and `memoryInitialized: false`. The read returns HTTP 409 with `USER_PREFERENCES_UNINITIALIZED`. Initialization returns `presentationFormat: "pptx"`.

## user-preferences-009

- Vitest: "opting out hides and ignores presentation preferences without erasing the saved value or legacy updates"
- Mode: run
- Given: A signed-in member with the presentation output format feature enabled has initialized and saved `presentationFormat: "pptx"`.
- When: The member turns off the `presentationOutputFormat` switch via `POST /api/feature-switches`, reads preferences, saves only `presentationFormat: "html"`, saves `theme: "dark"` with `presentationFormat: "html"`, re-initializes, then turns the switch back on and reads `GET /api/user-preferences`.
- Then: While opted out, reads and re-initialization omit `presentationFormat`, the format-only save returns HTTP 400 "At least one preference must be provided", and the mixed save returns HTTP 200 with theme `dark` and no `presentationFormat`. After opting back in, the read shows `presentationFormat: "pptx"` and theme `dark`.

## user-preferences-010

- Vitest: "non-opted-in callers retain legacy preferences without saving a presentation default"
- Mode: run
- Given: A signed-in member who has not opted in to the presentation output format feature.
- When: The member initializes with locale `en-US`, saves `theme: "dark"` with `presentationFormat: "pptx"`, and then saves only `presentationFormat: "pptx"` via `POST /api/user-preferences`.
- Then: Initialization omits `presentationFormat`. The mixed save returns HTTP 200 with theme `dark` and no `presentationFormat`. The format-only save returns HTTP 400.

## user-preferences-011

- Vitest: "ordinary members can opt in and save HTML and PPTX presentation preferences"
- Mode: run
- Given: A signed-in member with the ordinary `org:member` role, for whom the presentation output format switch is off by default.
- When: The member reads `GET /api/feature-switches`, initializes preferences, turns on `presentationOutputFormat` via `POST /api/feature-switches`, reads switches and preferences, then saves `presentationFormat` `html` and then `pptx`, reading after each save.
- Then: Effective switches start with the feature `false` and initialization omits `presentationFormat`. Opting in returns and then reads the switch as `true`, and preferences show a null `presentationFormat`. Each save and subsequent read return `html`, then `pptx`.

## user-preferences-012

- Vitest: "cli PATs retain legacy preference access but cannot save the enabled presentation preference"
- Mode: run
- Given: A member with the presentation output format feature enabled approves a CLI device login and obtains a CLI personal access token through `POST /api/cli/auth/device`, `POST /api/cli/auth/approve` and `POST /api/cli/auth/token`.
- When: Using the CLI token, the caller saves `theme: "dark"`, then `presentationFormat: "pptx"` with `theme: "light"`, then `locale: "en-US"` via `POST /api/user-preferences`. The member's browser session then turns the feature off; the CLI saves a mixed theme/format update and a format-only update; the session turns the feature back on and the CLI saves `locale: "en-US"`.
- Then: The theme save returns HTTP 200 with `dark` and null `presentationFormat`. The format save returns HTTP 400 "Presentation format preferences require a human session", and the next save shows theme still `dark` and null format. With the feature off, the mixed save returns HTTP 200 with theme `light` and no `presentationFormat`, and the format-only save returns HTTP 400 "At least one preference must be provided". After re-enabling, the CLI save shows theme `light` and null `presentationFormat`.
