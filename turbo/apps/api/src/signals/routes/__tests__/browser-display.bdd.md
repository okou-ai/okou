# browser-display

## browser-display-001

- Vitest: "a viewer seeds the provider size and calibrates native contents before publication"
- Mode: run
- Given: A workspace member's chat has a launched Run with cloud Browser use. The provider's native page reports layout metrics implying a native device scale of 2 and a page zoom of 1.25.
- When: The member opens the chat Browser with `POST /api/chat-threads/:threadId/browser/open` and an initial display of 390x600 at DPR 3.
- Then: The open returns HTTP 200. The provider receives exactly one session request with a 1170x1800 screen, and the published primary window's native contents size is 585x900.

## browser-display-002

- Vitest: "additional chat windows receive initial bounds and existing windows ignore another viewer hint"
- Mode: run
- Given: A workspace member has two chats with launched Runs and cloud Browser use; the first chat's Run already acquired the shared Browser through `POST /api/browsers/use`. Native pages report a device scale of 1.
- When: The member opens the second chat's Browser with `POST /api/chat-threads/:threadId/browser/open` and an initial display of 390x600 at DPR 3, then opens the first chat with a different display hint of 1000x700 at DPR 1.
- Then: Only one provider session is requested. A new native window is created for `about:blank` with width 1170 and height 1800, and its contents size is 1170x1800. Reopening the first chat returns its original window and changes no contents sizes, with no additional contents-size command.

## browser-display-003

- Vitest: "high-density landscape respects provider launch limits and the viewer raster budget"
- Mode: run
- Given: A workspace member's chat has a launched Run with cloud Browser use, and native pages report a device scale of 1.
- When: The member opens the chat Browser with `POST /api/chat-threads/:threadId/browser/open` and a high-density landscape initial display of 5000x3000 at DPR 3.
- Then: The open returns HTTP 200. The provider session requests a 3717x2229 screen, and the window's contents size is 3717x2229.

## browser-display-004

- Vitest: "high-density portrait respects provider launch limits and the viewer raster budget"
- Mode: run
- Given: A workspace member's chat has a launched Run with cloud Browser use, and native pages report a device scale of 1.
- When: The member opens the chat Browser with `POST /api/chat-threads/:threadId/browser/open` and a high-density portrait initial display of 400x1600 at DPR 3.
- Then: The open returns HTTP 200. The provider session requests a 1023x3456 screen, and the window's contents size is 1023x4095.

## browser-display-005

- Vitest: "a small panel respects provider launch limits and the viewer raster budget"
- Mode: run
- Given: A workspace member's chat has a launched Run with cloud Browser use, and native pages report a device scale of 1.
- When: The member opens the chat Browser with `POST /api/chat-threads/:threadId/browser/open` and a small-panel initial display of 200x100 at DPR 1.
- Then: The open returns HTTP 200. The provider session requests a 320x320 screen, and the window's contents size is 200x100.

## browser-display-006

- Vitest: "a preparation target moved into another chat cannot resize that chat"
- Mode: run
- Given: A workspace member has two chats with launched Runs; the first chat's Run already holds a Browser window. While the second chat's candidate window is being measured, the provider moves that page target into the first chat's window.
- When: The member opens the second chat's Browser with `POST /api/chat-threads/:threadId/browser/open` and an initial display of 390x600 at DPR 3.
- Then: The open returns HTTP 502. The first chat's window keeps its 1440x900 contents size, and only one contents-size command was ever sent.

## browser-display-007

- Vitest: "opens without viewer geometry retain the provider and contents defaults"
- Mode: run
- Given: A workspace member's chat has a launched Run with cloud Browser use.
- When: The member opens the chat Browser with `POST /api/chat-threads/:threadId/browser/open` without an initial display.
- Then: The open returns HTTP 200. The provider session requests the default 1440x900 screen, and the window's contents size is 1440x900.

## browser-display-008

- Vitest: "failed native calibration cleans only the unpublished candidate window"
- Mode: run
- Given: A workspace member has two chats with launched Runs; the first chat's Run already holds a Browser window. The provider fails native scale measurement for new pages ("Native scale unavailable").
- When: The member opens the second chat's Browser with `POST /api/chat-threads/:threadId/browser/open` and an initial display of 390x600 at DPR 3.
- Then: The open returns HTTP 502. The newly created candidate target is closed, and the only remaining native target belongs to the first chat's window.
