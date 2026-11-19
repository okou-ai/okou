# Chat thread sidebar resize

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-thread-sidebar-resize.test.tsx](chat-thread-sidebar-resize.test.tsx).

## chat-thread-sidebar-resize-001

Original test `A captured touch resize ends on pointerup and leaves the sidebar usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.test.tsx#L74).

- **Given** A user has opened the artifacts sidebar and begun resizing it with a primary touch.
- **When** They move the pointer and then end the gesture with pointerup.
- **Then** The sidebar reaches the expected 600px width, the blocking mask and pointer capture are cleared, and further movement does not change its width. The sidebar remains closable and its resize handle disappears when closed.

## chat-thread-sidebar-resize-002

Original test `A captured touch resize ends on pointercancel and leaves the sidebar usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.test.tsx#L74).

- **Given** A user has opened the artifacts sidebar and begun resizing it with a primary touch.
- **When** They move the pointer and then end the gesture with pointercancel.
- **Then** The sidebar reaches the expected 600px width, the blocking mask and pointer capture are cleared, and further movement does not change its width. The sidebar remains closable and its resize handle disappears when closed.

## chat-thread-sidebar-resize-003

Original test `A captured touch resize ends on lostpointercapture and leaves the sidebar usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.test.tsx#L74).

- **Given** A user has opened the artifacts sidebar and begun resizing it with a primary touch.
- **When** They move the pointer and then end the gesture after losing pointer capture.
- **Then** The sidebar reaches the expected 600px width, the blocking mask and pointer capture are cleared, and further movement does not change its width. The sidebar remains closable and its resize handle disappears when closed.

## chat-thread-sidebar-resize-004

Original test `A second touch cannot move or end the active resize`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.test.tsx#L112).

- **Given** A user has opened the artifacts sidebar, and a non-primary touch is followed by a primary touch starting a resize.
- **When** The second touch moves and ends, then the active primary touch ends.
- **Then** The second touch does not change the sidebar width or clear the blocking mask; ending the primary touch clears the mask.

## chat-thread-sidebar-resize-005

Original test `Closing the sidebar during a resize removes its blocking mask`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.test.tsx#L132).

- **Given** A user has opened the artifacts sidebar and started resizing it with a touch.
- **When** They close the sidebar while the touch is still held, then reopen the artifact.
- **Then** Closing removes the sidebar and its blocking mask and releases pointer capture. Reopening shows the resize handle without a blocking mask.
