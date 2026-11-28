# browser-admission

## browser-admission-001

- Vitest: "shared Browser public consumers > bounds a silent initial-window lookup and recovers through confirmed instance cleanup"
- Mode: run
- Given: An entitled Run can use the shared browser. The provider starts a session but withholds the initial native window reply until the request deadline.
- When: The Run requests browser use, retries promptly after replies are available, and retries again two minutes after the original start.
- Then: The first request returns HTTP 503 with `BROWSER_USE_TIMEOUT`, with one provider session request and no stop. The immediate retry returns HTTP 409 without another session request or a second window. The later retry returns an active browser after one stopped session and a second session request; the view matches the returned primary window and there is still one provider instance.

## browser-admission-002

- Vitest: "shared Browser public consumers > waits for the first window before admitting a sibling into a newly published instance"
- Mode: run
- Given: Two entitled Runs share a browser owner. The first use reaches provider lookup, whose response is held while the first window is being opened.
- When: The second Run requests use while the first request is held and retries after the first request finishes.
- Then: The concurrent request returns HTTP 409 while one target and one provider session request exist. After the first returns HTTP 200, the sibling receives a distinct primary window within the same instance. The provider has exactly those two window IDs and still only one instance and one session request.
