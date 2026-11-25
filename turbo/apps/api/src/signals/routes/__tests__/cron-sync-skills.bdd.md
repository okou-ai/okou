# cron-sync-skills

## cron-sync-skills-001

- Vitest: "Seed Skill bundles through sync-skills > publishes complete Seed bundles, skips unchanged content, and updates changed content"
- Mode: run
- Given: The cron caller holds the cron secret, the GitHub Seed skills source serves an archive for the built-in skills (`computer-use`, `gen`, `workflow-setup`) at commit `aaa…`, and bundle storage is empty.
- When: The caller requests `GET /api/cron/sync-skills` four times: first, again without a source change, after the source moves to a new commit with identical content, and after a new commit changes the `gen` instructions.
- Then: The first sync reports `synced: 3`, `skipped: 0`, `failed: 0`, `removed: 0`, `total: 3` and stores exactly three content-addressed bundles at `bundles/v1/<sha256>.tar.gz`, each holding its skill's source files. The second reports `total: 0`. The identical-content commit reports `skipped: 3` and leaves storage unchanged. The changed commit reports `synced: 1`, `skipped: 2`, `failed: 0`, `total: 3` and adds a bundle with the updated `gen` `SKILL.md`.

## cron-sync-skills-002

- Vitest: "Seed Skill bundles through sync-skills > retries an incomplete publication after a bundle provider failure"
- Mode: run
- Given: The cron caller holds the cron secret, the Seed skills source serves the built-in skills, and bundle storage rejects the next bundle write with an outage error.
- When: The caller requests `GET /api/cron/sync-skills` three times.
- Then: The first sync reports `synced: 2`, `failed: 1`, `total: 3`. The second reports `synced: 1`, `skipped: 2`, `failed: 0`, `total: 3`, and storage then holds three Seed bundles. The third reports `total: 0` and `failed: 0`.

## cron-sync-skills-003

- Vitest: "Seed Skill bundles through sync-skills > loads current Claude Code Seed bundles during preparation and retains delivered bytes"
- Mode: run
- Given: A signed-in member uses the Claude Code subscription model `claude-fable-5-1`, and the Seed skills were synced from an initial source.
- When: The member queues a chat Run, the cron syncs a changed source via `GET /api/cron/sync-skills`, the Run launches, the cron syncs a later source, and the member then starts another chat Run.
- Then: The first Run's execution input uses `claude-code` and mounts the built-in skills in order at `/home/user/.claude/skills/<name>`, each bundle holding exactly the changed source's files, with no duplicate mount paths across skills and storage mounts. The next Run's `gen` bundle holds the later source's `SKILL.md` and has a different SHA-256 from the first Run's `gen` bundle.

## cron-sync-skills-004

- Vitest: "Seed Skill bundle delivery > delivers prepared codex Seed bundles at their skill mounts"
- Mode: run
- Given: Row `codex`: a signed-in member with a subscription model has the Codex execution feature switch turned on via `POST /api/feature-switches`.
- When: The member starts a chat Run with model `gpt-6-luna` and the Runner reads its execution input.
- Then: The execution uses `codex` and mounts the built-in skills in order at `/home/user/.codex/skills/<name>`, each bundle containing a `SKILL.md`, with no duplicate mount paths across skills and storage mounts.

## cron-sync-skills-005

- Vitest: "Seed Skill bundle delivery > delivers prepared pi Seed bundles at their skill mounts"
- Mode: run
- Given: Row `pi`: a signed-in member with a subscription model has the Codex execution feature switch turned off via `POST /api/feature-switches`.
- When: The member starts a chat Run with model `gpt-6-luna` and the Runner reads its execution input.
- Then: The execution uses `pi` and mounts the built-in skills in order at `/home/user/.pi/agent/skills/<name>`, each bundle containing a `SKILL.md`, with no duplicate mount paths across skills and storage mounts.

## cron-sync-skills-006

- Vitest: "Seed Skill bundle delivery > filters disabled image generation from the published Seed bundles"
- Mode: run
- Given: A signed-in member has disabled the `image-generation` paid tool via `PATCH /api/paid-tools/image-generation`.
- When: The member starts a chat Run and the Runner reads its execution input.
- Then: The execution mounts exactly the `computer-use` and `workflow-setup` Seed skills (no `gen`), and each bundle contains a `SKILL.md`.
