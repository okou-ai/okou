# node-server

## node-server-001

- Vitest: "standalone Node server shutdown > SIGTERM releases keepalive connections and allows a replacement listener"
- Mode: run
- Intent: review
- Given: A standalone Node API process has an open keepalive socket that served a successful health response.
- When: The operator signals shutdown with SIGTERM, then starts another server on the same port.
- Then: The existing socket closes and the original exits with code 0 and no signal. The replacement serves HTTP 200 and healthy JSON and can also shut down with exit code 0.

## node-server-002

- Vitest: "standalone Node server shutdown > SIGINT releases keepalive connections and allows a replacement listener"
- Mode: run
- Intent: review
- Given: A standalone Node API process has an open keepalive socket that served a successful health response.
- When: The operator signals shutdown with SIGINT, then starts another server on the same port.
- Then: The existing socket closes and the original exits with code 0 and no signal. The replacement serves HTTP 200 and healthy JSON and can also shut down with exit code 0.

## node-server-003

- Vitest: "standalone Node server shutdown > cancels active work, rejects late health requests, and tolerates repeated signals"
- Mode: run
- Intent: review
- Given: A standalone API server has active work and an open connection.
- When: The operator sends SIGTERM, waits for cancellation, sends repeated signals and checks the process still answers IPC. A health request is attempted late on the existing connection before allowing cleanup.
- Then: The active request reports cancellation, the late health response is HTTP 503 and closes the connection, no healthy response is returned, and shutdown exits with code 0.

## node-server-004

- Vitest: "standalone Node server shutdown > allows background cleanup after the HTTP listener closes"
- Mode: run
- Intent: review
- Given: A background HTTP request has returned HTTP 200 but the original process still owns cleanup work.
- When: The operator sends SIGTERM and starts a replacement on the same port before permitting the old process to finish cleanup.
- Then: The original work is cancelled and the port can be reused. The replacement shuts down successfully and the old process cleans up and exits with code 0.

## node-server-005

- Vitest: "standalone Node server shutdown > bounds shutdown with stalled /work handles"
- Mode: run
- Intent: review
- Given: A standalone Node server has a stalled foreground request to /work.
- When: The operator sends SIGTERM and leaves the handle stalled.
- Then: The process signals cancellation, closes the HTTP peer and exits with code 1 and no signal within the test deadline.

## node-server-006

- Vitest: "standalone Node server shutdown > bounds shutdown with stalled /background handles"
- Mode: run
- Intent: review
- Given: A standalone Node server has a stalled background handle after a successful /background response.
- When: The operator sends SIGTERM and leaves the handle stalled.
- Then: The process signals cancellation, closes the HTTP peer and exits with code 1 and no signal within the test deadline.
