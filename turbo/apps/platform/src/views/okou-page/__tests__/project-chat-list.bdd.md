# Project chat list

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [project-chat-list.test.tsx](project-chat-list.test.tsx).

## project-chat-list-001

Original test `Projects populate the inbox without chats outside them (mobile: false, archived outside: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L158).

- **Given** On desktop, the inbox has a Launch Project with one active chat and one archived chat outside it.
- **When** I inspect the inbox, then expand Launch and the empty Research Project.
- **Then** Launch starts collapsed. Its active chat appears when expanded. The inbox empty messages and archived-chat control are absent throughout, including when the outside archived chat is present.

## project-chat-list-002

Original test `Projects populate the inbox without chats outside them (mobile: false, archived outside: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L158).

- **Given** On desktop, the inbox has a Launch Project with one active chat and no archived chat outside it.
- **When** I inspect the inbox, then expand Launch and the empty Research Project.
- **Then** Launch starts collapsed. Its active chat appears when expanded. The inbox empty messages and archived-chat control are absent throughout.

## project-chat-list-003

Original test `Projects populate the inbox without chats outside them (mobile: true, archived outside: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L158).

- **Given** On mobile, the inbox has a Launch Project with one active chat and one archived chat outside it.
- **When** I inspect the inbox, then expand Launch and the empty Research Project.
- **Then** Launch starts collapsed. Its active chat appears when expanded. The inbox empty messages and archived-chat control are absent throughout, including when the outside archived chat is present.

## project-chat-list-004

Original test `Projects populate the inbox without chats outside them (mobile: true, archived outside: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L158).

- **Given** On mobile, the inbox has a Launch Project with one active chat and no archived chat outside it.
- **When** I inspect the inbox, then expand Launch and the empty Research Project.
- **Then** Launch starts collapsed. Its active chat appears when expanded. The inbox empty messages and archived-chat control are absent throughout.

## project-chat-list-005

Original test `An inbox without Projects or active chats leads to archived chats (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L207).

- **Given** On desktop, the inbox has no Projects or active chats, and one archived chat.
- **When** I open the inbox and choose to show archived chats.
- **Then** The inbox empty message appears, and the archived chat becomes visible.

## project-chat-list-006

Original test `An inbox without Projects or active chats leads to archived chats (mobile: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L207).

- **Given** On mobile, the inbox has no Projects or active chats, and one archived chat.
- **When** I open the inbox and choose to show archived chats.
- **Then** The inbox empty message appears, and the archived chat becomes visible.

## project-chat-list-007

Original test `An unfolded Project without chats offers the archived ones it holds`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L240).

- **Given** The current conversation is an ordinary chat outside the Launch Project. Launch contains one archived chat, while Research has no chats.
- **When** I expand Research, expand Launch, and choose to show Launch's archived chats.
- **Then** Research says it has no chats; Launch initially says it has no chats, then lists its archived chat. The current conversation remains selected.

## project-chat-list-008

Original test `A Project lists every chat it holds`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L264).

- **Given** A Project contains 21 active chats ordered from Member 1 oldest to Member 21 newest, and another ordinary chat is outside the Project.
- **When** I expand the Project.
- **Then** All 21 Project chats are listed, newest first from Member 21 to oldest last, Member 1.

## project-chat-list-009

Original test `Pinned chats in a Project move among themselves`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L285).

- **Given** A Project contains two pinned chats and one regular chat; an outside pinned chat has a pin rank between the Project pins but is not in the Project.
- **When** I expand the Project, move the second pin up, then move it down.
- **Then** The Project initially lists First pin, Second pin, then Regular chat. Moving Second pin up swaps the two Project pins and keeps Regular chat last; moving it down restores the initial order. The outside pin does not join the Project's ordering.

## project-chat-list-010

Original test `A pinned chat moves past another Agent's pin in the same Project`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L353).

- **Given** A Project contains pinned chats belonging to two different Agents, with Other Agent pin before Second pin.
- **When** I expand the Project and move Second pin up.
- **Then** Second pin moves before Other Agent pin in the Project list.

## project-chat-list-011

Original test `Clicking an expanded, unselected Project title folds its chats and keeps the current conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L387).

- **Given** The current conversation is an ordinary chat outside the collapsed Launch Project, which contains Launch planning.
- **When** I click the Launch Project title to expand it, then click the title again to collapse it.
- **Then** Launch planning appears while expanded. After collapsing, the current conversation remains selected and its route is unchanged.
