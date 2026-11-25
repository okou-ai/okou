# connector-skill-bundles

## connector-skill-bundles-001

- Vitest: "Connector Skill bundle delivery > delivers current custom configuration and Skill bytes"
- Mode: run
- Given: An authenticated Chat owner connects a no-auth custom HTTP connector with authored Skill Markdown and queues a Claude run, then changes the base URL and reconnects the same account before launch.
- When: The queued run launches and the Runner reads its execution firewall entry and downloads the referenced Skill bundle.
- Then: The firewall names the exact custom connector and current base URL. The bundle mounts under /home/user/.claude/skills at that connector's Skill path, and SKILL.md contains the authored instructions.

## connector-skill-bundles-002

- Vitest: "Connector Skill bundle delivery > delivers current authorized claude-code Skill bytes during preparation and for the next Run"
- Mode: run
- Given: An authenticated Chat owner can run claude-code using claude-fable-5-1, has a connected custom connector with a Skill and a connected Nintendo Store bundled Skill, and has unselected and foreign workspace definitions. The owner changes the selected Skill after queuing the run.
- When: The Runner obtains execution, reads the mounted bundles, then does so for a subsequent run after a second Skill update. The owner creates Workflows whose names collide with both connector Skill names and starts another run.
- Then: The first execution uses claude-code, includes Nintendo Store and exactly one custom mount under /home/user/.claude/skills, and its SKILL.md contains the queued-time update. The next run's custom bundle has a new digest and contains the second update. In the collision run each name appears exactly once with the corresponding Workflow instructions.

## connector-skill-bundles-003

- Vitest: "Connector Skill bundle delivery > delivers current authorized codex Skill bytes during preparation and for the next Run"
- Mode: run
- Given: An authenticated Chat owner can run codex using gpt-6-luna, has a connected custom connector with a Skill and a connected Nintendo Store bundled Skill, and has unselected and foreign workspace definitions. The owner changes the selected Skill after queuing the run.
- When: The Runner obtains execution, reads the mounted bundles, then does so for a subsequent run after a second Skill update. The owner creates Workflows whose names collide with both connector Skill names and starts another run.
- Then: The first execution uses codex, includes Nintendo Store and exactly one custom mount under /home/user/.codex/skills, and its SKILL.md contains the queued-time update. The next run's custom bundle has a new digest and contains the second update. In the collision run each name appears exactly once with the corresponding Workflow instructions.

## connector-skill-bundles-004

- Vitest: "Connector Skill bundle delivery > delivers current authorized pi Skill bytes during preparation and for the next Run"
- Mode: run
- Given: An authenticated Chat owner can run pi using gpt-6-luna, has a connected custom connector with a Skill and a connected Nintendo Store bundled Skill, and has unselected and foreign workspace definitions. The owner changes the selected Skill after queuing the run.
- When: The Runner obtains execution, reads the mounted bundles, then does so for a subsequent run after a second Skill update. The owner creates Workflows whose names collide with both connector Skill names and starts another run.
- Then: The first execution uses pi, includes Nintendo Store and exactly one custom mount under /home/user/.pi/agent/skills, and its SKILL.md contains the queued-time update. The next run's custom bundle has a new digest and contains the second update. In the collision run each name appears exactly once with the corresponding Workflow instructions.
