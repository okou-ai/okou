# Chat navigation browser

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-navigation-browser.test.tsx](chat-navigation-browser.test.tsx).

## chat-navigation-browser-001

Original test `A live Browser card resumes a window reclaimed after its summary was read`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L273).

- **Given** A conversation contains a live Browser summary, but its session was reclaimed after the summary was read.
- **When** The user opens the summary card.
- **Then** The Browser resumes with enabled remote input, and text entered there is sent to the resumed page.

## chat-navigation-browser-002

Original test `A summary card and a previous Start cannot authorize a reopened shared viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L351).

- **Given** A Browser summary card is available, and an earlier Start opened its shared viewer successfully; authorization is later denied.
- **When** The user closes and reopens the viewer from the card.
- **Then** The reopened sidebar shows the authorization-required message and does not expose remote browser input; the prior Start and summary do not authorize it.

## chat-navigation-browser-003

Original test `An unauthorized Browser keeps its card and sidebar with an authorization placeholder`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L448).

- **Given** The conversation includes a Browser card but its Browser read is unauthorized.
- **When** The user opens the card.
- **Then** The card remains and the sidebar displays an authorization placeholder with a close control, but no remote input or ordinary “Browser not live” message.

## chat-navigation-browser-004

Original test `A committed Browser grant via event revalidates a denial and observes later revocation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L493).

- **Given** A Browser is denied because the chat has no grant, while the user can change connector settings.
- **When** The user grants Browser access and the grant is confirmed by an event, then access is revoked by a later event.
- **Then** The initial denial is revalidated after the grant, remote input becomes enabled, and the later revocation restores the authorization message and removes remote input.

## chat-navigation-browser-005

Original test `A committed Browser grant via snapshot revalidates a denial and observes later revocation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L493).

- **Given** A Browser is denied because the chat has no grant, while the user can change connector settings.
- **When** The user grants Browser access and the grant is confirmed by a snapshot, then access is revoked by a later event.
- **Then** The initial denial is revalidated after the grant, remote input becomes enabled, and the later revocation restores the authorization message and removes remote input.

## chat-navigation-browser-006

Original test `A canonical regrant restores the Browser after a local disable confirmed by event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L675).

- **Given** A live Browser works in a chat whose Browser grant is enabled.
- **When** The user disables the grant, the change is confirmed by an event, and a canonical update regrants access.
- **Then** The sidebar first shows the authorization message and loses remote input; after the regrant is revalidated, remote input is enabled again.

## chat-navigation-browser-007

Original test `A canonical regrant restores the Browser after a local disable confirmed by snapshot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L675).

- **Given** A live Browser works in a chat whose Browser grant is enabled.
- **When** The user disables the grant, the change is confirmed by a snapshot, and a canonical update regrants access.
- **Then** The sidebar first shows the authorization message and loses remote input; after the regrant is revalidated, remote input is enabled again.

## chat-navigation-browser-008

Original test `Browser tab admission uses a stable picker-independent budget and protects the actual selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1107).

- **Given** A Browser has 12 tabs, the initial admission budget is 240, and the user selects Page 12.
- **When** The user resizes at the same budget, then increases the budget to 800 with a 1000-pixel panel and resizes again.
- **Then** Initially only Example, Page 2, and Page 3 are admitted; the All tabs control remains available, and Page 12 replaces Page 3 while staying selected. The unchanged budget does not alter admission; at budget 800 all 12 tabs are admitted and All tabs disappears.

## chat-navigation-browser-009

Original test `Browser tab admission keeps a zero first-open budget until the native panel motion settles`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1136).

- **Given** The Browser is first opened with zero tab-admission budget and a native panel motion in progress.
- **When** The budget and panel dimensions increase before the motion ends, then the panel motion ends.
- **Then** No tabs are admitted before the motion settles, though All tabs is available. After it settles, all 12 tabs appear and Example remains selected.

## chat-navigation-browser-010

Original test `Browser tab admission narrows conservatively on the chat-list action before transitionrun`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1157).

- **Given** The Browser has a wide tab budget and Page 12 selected; the chat list is hidden and then shown with width transitions enabled.
- **When** The chat-list action begins before native transition events, and both panel and list motions run while the budget narrows from 800 to 500 and then 200.
- **Then** Admission conservatively narrows to the two-tab limit while preserving Page 12. The lower budget and motion completion do not widen admission during that transition.

## chat-navigation-browser-011

Original test `Browser tab admission settles surviving shell motion after navigation cancels visibility paint`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1187).

- **Given** The Browser begins narrow with Page 12 selected; showing the chat list starts panel and list motions.
- **When** The user navigates away before visibility paint completes, returns, opens the Browser again, and the surviving motions finish in sequence.
- **Then** The old sidebar is removed during navigation, while the chat-list width owner remains. On return, admission stays at two tabs while either motion remains and widens to all 12 only after both finish, with Page 12 selected.

## chat-navigation-browser-012

Original test `Browser tab admission holds widening when panel finishes before the other width owner`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1253).

- **Given** The Browser starts with a narrow budget and Page 12 selected while panel and chat-list width motions are pending.
- **When** The panel motion finishes first, then the chat-list motion finishes.
- **Then** Admission remains at two tabs after the first motion and widens to all 12 only after both motions finish; Page 12 remains selected.

## chat-navigation-browser-013

Original test `Browser tab admission holds widening when chat-list finishes before the other width owner`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1253).

- **Given** The Browser starts with a narrow budget and Page 12 selected while panel and chat-list width motions are pending.
- **When** The chat-list motion finishes first, then the panel motion finishes.
- **Then** Admission remains at two tabs after the first motion and widens to all 12 only after both motions finish; Page 12 remains selected.

## chat-navigation-browser-014

Original test `Browser tab admission cannot unlock an old wide budget after native cancellation and reversal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1285).

- **Given** The Browser has a wide budget and Page 12 selected; hiding and then showing the chat list starts width motions that are subsequently reversed by hiding it again.
- **When** The old motions are cancelled, and late transition-end events arrive for those superseded motions before the new motions finish.
- **Then** The old wide budget does not unlock admission: only two tabs remain admitted through cancellation and the new transition, and all 12 appear only after both new motions end.

## chat-navigation-browser-015

Original test `Browser tab admission commits direct, no-motion and reduced-motion geometry without transition events`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1320).

- **Given** The Browser starts with a 240 tab budget and direct geometry changes can occur without transition events.
- **When** The user narrows geometry to a 340 budget and resizes the chat list by keyboard, hides the list at budget 800, then enables reduced motion and shows it at budget 200.
- **Then** Admission changes to five tabs after keyboard resizing, to all 12 when the list is hidden, and to Example and Page 2 after it is shown under reduced motion.

## chat-navigation-browser-016

Original test `Browser tab admission uses native viewport changes made while disconnected on automatic recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1354).

- **Given** A Browser with 12 tabs has a wide budget, then its native connection drops and the viewer begins reconnecting.
- **When** While disconnected, the viewport changes to width 916 and the budget narrows to 240; automatic recovery completes, then the budget widens to 800.
- **Then** Input is disabled during reconnection. On recovery, input is enabled and the remote viewport is 916 by 600; three tabs are admitted, then all 12 are admitted at budget 800 with Example selected.

## chat-navigation-browser-017

Original test `The embedded Okou viewer retains its sizing preference when the menu reopens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1385).

- **Given** The embedded Browser viewer is open in a desktop conversation and its sizing preference is Follow panel.
- **When** The user selects Off in the sizing menu, closes the menu, and reopens it.
- **Then** Off remains selected when the menu reopens; opening Browser settings closes the sizing menu.

## chat-navigation-browser-018

Original test `The shared sidebar with provider liveUrl=https://viewer.example/live operates its chat window and keeps it alive without input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1424).

- **Given** A shared Browser sidebar is open with provider liveUrl set to https://viewer.example/live and its chat window is leased without user input.
- **When** The user enters next.example/path in the address field, submits it, then closes the sidebar.
- **Then** The address becomes http://next.example/path, the remote input remains enabled, and closing the sidebar cancels the pending lease request and removes the sidebar.

## chat-navigation-browser-019

Original test `The shared sidebar with provider liveUrl=null operates its chat window and keeps it alive without input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1424).

- **Given** A shared Browser sidebar is open with provider liveUrl set to null and its chat window is leased without user input.
- **When** The user enters next.example/path in the address field, submits it, then closes the sidebar.
- **Then** The address becomes http://next.example/path, the remote input remains enabled, and closing the sidebar cancels the pending lease request and removes the sidebar.

## chat-navigation-browser-020

Original test `Resizing the browser sidebar synchronizes the remote display to the committed panel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1495).

- **Given** The Browser sidebar is open with a remote display size of 900 by 600 and its canvas receives a frame.
- **When** The user resizes the sidebar so the committed canvas width becomes 916 pixels.
- **Then** The remote display viewport updates to 916 by 600.

## chat-navigation-browser-021

Original test `The embedded Okou viewer owns its shortcuts while the conversation keeps its shortcuts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1535).

- **Given** The embedded Browser address field and conversation message box are both available.
- **When** The user presses the workspace-search shortcut while focused in each field in turn.
- **Then** The Browser field keeps the shortcut and does not open workspace search; the conversation message box opens workspace search, and Escape returns focus to it.

## chat-navigation-browser-022

Original test `The chat browser sidebar forwards a touch tap exactly once`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1566).

- **Given** The Browser viewer is live and enabled for remote input.
- **When** The user performs one touch tap on the viewer surface.
- **Then** The remote browser receives exactly one mouse press and one mouse release at coordinates 720, 450.

## chat-navigation-browser-023

Original test `Open the mobile chat browser and return to the conversation (active=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1620).

- **Given** A mobile standalone-mode conversation has no active Browser session.
- **When** The user opens the Browser from More actions, starts a session, and closes it.
- **Then** The Browser opens and offers an external-page link in the toolbar targeting a new page; closing it returns to the visible conversation.

## chat-navigation-browser-024

Original test `Open the mobile chat browser and return to the conversation (active=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1620).

- **Given** A mobile standalone-mode conversation has an active Browser session.
- **When** The user opens the Browser from More actions and closes it.
- **Then** The existing Browser opens with an external-page link in the toolbar targeting a new page; closing it returns to the visible conversation.

## chat-navigation-browser-025

Original test `Start and close a browser from the thread sidebar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1681).

- **Given** A conversation has no live Browser session, and the cloud Browser panel is enabled.
- **When** The user opens the sidebar, starts a Browser, closes it, then opens the sidebar and starts another session.
- **Then** The first sidebar shows Browser not live and offers Start; closing the started session sends one close request and returns to the conversation. Input on the retired surface cannot send text, while the reopened surface sends its own text and keyboard input.

## chat-navigation-browser-026

Original test `Open a stopped browser card and offer a new session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1799).

- **Given** A conversation contains a card for a stopped Browser and no Browser sidebar is open.
- **When** The user opens the stopped card.
- **Then** The sidebar says Browser not live and offers an enabled Start browser button.

## chat-navigation-browser-027

Original test `Take over the cloud browser without stopping the working run and hand it back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L1839).

- **Given** A Browser is open while a chat run is working.
- **When** The user takes over, waits until the takeover is accepted, then hands back while late output from an earlier run arrives.
- **Then** The Browser shows local control and the takeover message, and Hand back stays disabled until acceptance. Late earlier output does not clear control; handback sends its message into the still-working run, returns the viewer to its working status, and closing sends one Browser close request.

## chat-navigation-browser-028

Original test `Accepted mouse input on the live page takes the cloud browser over from a working run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L2026).

- **Given** A chat run is working and the live Browser page is visible; mouse input is accepted on the page.
- **When** The user interacts with the page using mouse input and then additional accepted input.
- **Then** The viewer transfers to the user, shows the takeover message once, enables Hand back, and returns to working status after handback; the run continues.

## chat-navigation-browser-029

Original test `Accepted keyboard input on the live page takes the cloud browser over from a working run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L2026).

- **Given** A chat run is working and the live Browser page is visible; keyboard input is accepted on the page.
- **When** The user types on the page and then additional accepted input.
- **Then** The viewer transfers to the user, shows the takeover message once, enables Hand back, and returns to working status after handback; the run continues.

## chat-navigation-browser-030

Original test `Accepted composition input on the live page takes the cloud browser over from a working run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L2026).

- **Given** A chat run is working and the live Browser page is visible; composition input is accepted on the page.
- **When** The user enters composition text and then additional accepted input.
- **Then** The viewer transfers to the user, shows the takeover message once, enables Hand back, and returns to working status after handback; the run continues.

## chat-navigation-browser-031

Original test `Accepted touch input on the live page takes the cloud browser over from a working run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L2026).

- **Given** A chat run is working and the live Browser page is visible; touch input is accepted on the page.
- **When** The user taps the page and then provides additional accepted input.
- **Then** The viewer transfers to the user, shows the takeover message once, enables Hand back, and returns to working status after handback; the run continues.

## chat-navigation-browser-032

Original test `Page-input takeover ignores letterboxing and respects the Lab switch (true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L2156).

- **Given** A chat run is working and the Browser viewer is letterboxed; the Cloud Browser Panel switch is enabled.
- **When** The user clicks in the letterboxed area, then types within the page.
- **Then** The letterbox click does not trigger takeover. Page typing sends a remote key event, displays the takeover message, and changes the viewer to user control.

## chat-navigation-browser-033

Original test `Page-input takeover ignores letterboxing and respects the Lab switch (false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L2156).

- **Given** A chat run is working and the Browser viewer is letterboxed; the Cloud Browser Panel switch is disabled.
- **When** The user clicks in the letterboxed area, then types within the page.
- **Then** The letterbox click does not trigger takeover. Page typing sends a remote key event, but no takeover message or user-control state appears.

## chat-navigation-browser-034

Original test `A delayed handback cannot clear a newer run's page-input takeover`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L2231).

- **Given** A Browser is taken over while one run works; handback is submitted but its response is delayed, and a newer run starts before it settles.
- **When** The user takes over the Browser page during the newer run, then the delayed handback completes.
- **Then** The newer takeover remains in force. Persisted chat events record takeover, handback, and the newer takeover in that order, and the viewer shows user control.

## chat-navigation-browser-035

Original test `A failed handback does not poison the next explicit handback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L2358).

- **Given** A working chat run's Browser has been taken over, and the first handback request fails.
- **When** The user retries Hand back explicitly.
- **Then** After the failure the user still has control and Hand back is enabled; the retry succeeds and the viewer returns to working status.

## chat-navigation-browser-036

Original test `Hand back after using the cloud browser between runs continues in one step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx#L2413).

- **Given** A chat run to download last month's invoices has completed and asks the user to sign in to the billing site. The cloud browser is open, with nobody currently controlling it.
- **When** The user clicks in the browser page, then clicks Hand back.
- **Then** The browser shows “You're in control” after the click, without showing the take-over message. After hand-back, the chat shows “I'm done in the browser. Please continue.” and indicates that it is working.
