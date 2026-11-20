# Browser frame rate

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-frame-rate.test.tsx](browser-frame-rate.test.tsx).

## browser-frame-rate-001

Original test `FPS is default Off and selected through a left-opening radio submenu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L148).

- **Given** A remote browser viewer is open with FPS hidden.
- **When** The user opens Browser settings and chooses FPS > On from the left-opening radio submenu, then chooses Off and reopens the submenu.
- **Then** Off is initially selected, and On displays a 128-by-48 FPS overlay without sending browser requests. On and Off selections are reflected when the submenu is reopened; Off removes the overlay, and Escape returns focus to Browser settings.

## browser-frame-rate-002

Original test `FPS can be enabled with keyboard menu navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L189).

- **Given** A remote browser viewer is open and FPS is Off.
- **When** The user navigates the settings menus with the keyboard and selects FPS On.
- **Then** The FPS overlay appears, and focus returns to Browser settings.

## browser-frame-rate-003

Original test `The overlay follows the contained image origin when the viewer is resized`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L203).

- **Given** The viewer is displaying an image and FPS is Off.
- **When** The user enables FPS, then resizes the viewer from 1600×900 to 800×1000.
- **Then** The overlay begins at image origin (80, 0) in the first size and moves to (0, 250) after resizing, following the contained image origin.

## browser-frame-rate-004

Original test `Choosing On again preserves the running counter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L235).

- **Given** FPS is enabled and the viewer is measuring frames.
- **When** The user selects On again, then nine frames paint during a one-second measurement window.
- **Then** The counter continues rather than restarting and displays 9 FPS.

## browser-frame-rate-005

Original test `Successful paints produce one-, two-, and three-digit readings, an area chart, and real zero`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L247).

- **Given** FPS is enabled and the viewer is receiving successfully painted frames.
- **When** The viewer records 9, 60, and 120 frames in successive one-second measurement windows, then receives no frames for one second.
- **Then** The readings display 9, 60, 120, and then a real 0 FPS. The chart has one line and an area with two paths; at 120 FPS its final chart point is at approximately y=9.6.

## browser-frame-rate-006

Original test `Superseded queued frames do not inflate FPS, and decoding failure makes sampling unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L267).

- **Given** FPS is enabled and a frame decode is pending.
- **When** Two newer frames arrive before that decode completes, then a later frame fails to decode.
- **Then** Only two frames are painted and counted, displaying 2 FPS; the decoding failure makes sampling unavailable and displays an em dash rather than a numeric reading.

## browser-frame-rate-007

Original test `Pause and delayed sampling leave chart gaps rather than zero-filled history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L302).

- **Given** FPS is enabled and two successive one-second windows each contain one painted frame.
- **When** The browser becomes hidden for five seconds, becomes visible again, and then sampling continues without frames before later receiving frames.
- **Then** Each active window displays 1 FPS. Hiding makes the reading unavailable; after returning, it remains unavailable until a one-second window produces 0 FPS. The chart has gaps rather than zero-filled history, retains two lines, and updates as time advances.

## browser-frame-rate-008

Original test `The chart grows with a high reading and shrinks after its peak expires and six seconds settle`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L341).

- **Given** FPS is enabled and a one-second window records 120 frames, followed by one recording 10 frames.
- **When** The viewer waits 29 seconds for the high reading to expire, then records 10 frames in each of six successive one-second windows.
- **Then** The 10 FPS point initially appears at approximately y=44.8. After the peak expires and six seconds settle, the chart point moves to approximately y=24; the counter displays 0 FPS before the six later readings.

## browser-frame-rate-009

Original test `Recovery resets FPS and cannot count a late decode from the retired connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L367).

- **Given** FPS is enabled, the viewer has recorded 9 FPS, and an additional frame decode is pending.
- **When** The browser connection drops and recovers before the pending decode completes.
- **Then** The viewer shows a reconnecting state and disables remote input during recovery. Recovery resets the chart and reading; the retired connection's late decode is closed without painting or affecting the replacement image, and the reading later becomes 0 FPS.

## browser-frame-rate-010

Original test `Changing capture settings starts a fresh measurement window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L411).

- **Given** FPS is enabled and the viewer has recorded 9 FPS.
- **When** The user changes the image format to PNG.
- **Then** The reading resets to an em dash and the chart history is cleared; after one second without frames, the reading is 0 FPS.

## browser-frame-rate-011

Original test `Selecting another tab resets its reading and history; disabling discards collected paints`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L431).

- **Given** FPS is enabled and the selected Example tab has recorded 9 FPS.
- **When** The user selects Other, returns to Example, waits two seconds, disables FPS, waits five seconds, and enables it again.
- **Then** Selecting either tab resets the reading to an em dash and clears chart history; the address follows the selected tab. After two seconds with no frames the reading is 0 FPS. Disabling removes the overlay, and re-enabling starts with an empty chart.
