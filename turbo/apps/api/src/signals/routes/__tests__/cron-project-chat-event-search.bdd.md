# cron-project-chat-event-search

## cron-project-chat-event-search-001

- Vitest: "chat search publication > requires the cron secret"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/project-chat-event-search`.
- Then: The API responds with HTTP 401 and exactly `{ error: { code: "UNAUTHORIZED", message: "Invalid cron secret" } }`.

## cron-project-chat-event-search-002

- Vitest: "chat search publication > withdraws recalled queued messages while another input is published"
- Mode: run
- Given: A signed-in member owns an onboarded workspace with a configured Runner group and an open conversation.
- When: The member sends a unique keyword message via `POST /api/chat/events`, revokes it with `revokesEventId`, then sends the keyword again and concurrently revokes it while sending a second unique keyword, searching with `GET /api/chat/search` after each step.
- Then: Every send returns HTTP 201. The first keyword is found in the thread before revocation and returns no results after it; after the concurrent revoke and send, the revoked keyword still returns no results while the surviving keyword is found in the same thread.

## cron-project-chat-event-search-003

- Vitest: "chat search publication > publishes scoped MCP and Web search hits and respects revoked sharing"
- Mode: run
- Given: An onboarded owner sends two new conversations containing a shared keyword; a peer in the same workspace and the same user in a second workspace each send one conversation with the keyword. The owner authorizes an MCP client and belongs to both workspaces.
- When: The owner searches via `GET /api/chat/search` and calls the `/mcp` tools `search_chat_messages` and `get_chat_messages`; the owner then creates two Projects with `POST /api/projects`, moves one thread into each in turn with `PUT /api/chat-threads/:id/project`, and searches by `projectId` with owner, peer, and other-workspace tokens.
- Then: Web search returns exactly the owner's two threads, stably on repeat, and MCP search returns the same hits mapped to `threadId` with `projectId`/`projectName` null; `get_chat_messages` contains the matched text. While the thread is in each Project, a Project-scoped search returns that thread with the Project's ID and name; after it moves to the second Project, the first Project's search is empty, and the peer and other-workspace tokens get no hits in the second Project. Unscoped owner search returns the two owner threads and the peer's unscoped search returns one hit.

## cron-project-chat-event-search-004

- Vitest: "chat search publication > publishes Unicode search hits with UTF-16 ranges"
- Mode: run
- Given: Row "UTF-16 ranges". An onboarded owner with an MCP client sends four conversations: `ACK-QA-A1-🧪-中文`, `𠀀-代理`, `e\u0301-组合` (decomposed e plus combining acute accent), and `👩‍💻-连接`.
- When: The owner searches each CJK keyword, the extra queries `中文 🧪` and `e\u0301`, and absent keywords through the MCP `search_chat_messages` tool and `GET /api/chat/search`.
- Then: MCP and Web results match in content and ranges. Each keyword returns exactly one hit in its thread with UTF-16 ranges 13–15, 3–5, 3–5, and 6–8 that slice to the keyword. `中文 🧪` matches range 13–15 and `e\u0301` matches range 0–1. The keywords `🧪`, `👩‍💻`, `!!!`, `中`, `𠀀`, and precomposed `é` (U+00E9) return no results.

## cron-project-chat-event-search-005

- Vitest: "chat search publication > publishes Unicode search hits with the documented token policy"
- Mode: run
- Given: Row "the documented token policy". An onboarded owner with an MCP client sends three conversations: `Prefix FoObAr suffix`, `1️⃣ 数字`, and `X-分词测试`.
- When: The owner searches `foobar`, `1️⃣`, `词测试`, `prefix suffix`, and absent keywords through the MCP `search_chat_messages` tool and `GET /api/chat/search`.
- Then: MCP and Web results match. `foobar` matches range 7–13 highlighting `FoObAr`, `1️⃣` matches range 0–1 highlighting `1`, and `词测试` matches range 3–6. `prefix suffix` returns ranges 0–6 and 14–20. `foobar 中`, `foo`, and `prefix nonexistent` return no results.

## cron-project-chat-event-search-006

- Vitest: "chat search publication > returns published MCP and Web search hits newest first"
- Mode: run
- Given: A member opens a conversation at 2026-10-12T08:00:00Z and posts three keyword messages labelled oldest, middle, and newest at 08:02:49.990Z, 08:02:50.000Z, and 08:02:50.010Z.
- When: The member searches the keyword through the MCP `search_chat_messages` tool and `GET /api/chat/search`.
- Then: MCP returns the messages ordered newest, middle, oldest, and Web search returns the same contents with the same `createdAt` values in the same order.
