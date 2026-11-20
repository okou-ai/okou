# Discord source presentation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [discord-source-presentation.test.tsx](discord-source-presentation.test.tsx).

## discord-source-presentation-001

Original test `Discord source links preserve guild and bot-DM destinations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-source-presentation.test.tsx#L20).

- **Given** A chat contains Discord source messages with a guild permalink, a bot-DM permalink, and one source without a permalink.
- **When** The chat is displayed.
- **Then** The two valid permalinks appear as Discord links opening in a new tab with noreferrer, preserving their exact guild and DM destinations. The source without a permalink is labeled Discord but is not a link.

## discord-source-presentation-002

Original test `Discord sources never link outside discord.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-source-presentation.test.tsx#L110).

- **Given** A chat contains Discord sources with a deceptive discord.com subdomain, another host, HTTP instead of HTTPS, and a Discord invite URL.
- **When** The chat is displayed.
- **Then** None of those destinations is rendered as a link, and each source is shown as an unlinked Discord label.

## discord-source-presentation-003

Original test `Activity identifies a Discord run as its source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-source-presentation.test.tsx#L167).

- **Given** An activity record is a completed run triggered by Discord.
- **When** The activity page is opened.
- **Then** It shows the run title, a Source label, and Discord as the source.
