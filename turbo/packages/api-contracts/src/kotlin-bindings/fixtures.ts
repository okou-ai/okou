import type { ZodType } from "zod";
import { agentsMainContract } from "../contracts/agents";
import {
  chatThreadsContract,
  chatThreadSnapshotArchiveSchema,
} from "../contracts/chat-threads";
import { projectsContract } from "../contracts/projects";
import type { KotlinRouteBinding, KotlinTypeBinding } from "./bindings";

/** Compile/read proofs only: these routes are not installed Android consumers. */
export const kotlinFixtureRoutes: readonly KotlinRouteBinding[] = [
  {
    name: "chatSnapshot",
    response: "ChatSnapshot",
    route: chatThreadsContract.snapshot,
  },
  {
    name: "chatEvents",
    response: "ChatEvents",
    route: chatThreadsContract.events,
  },
  {
    name: "indicators",
    response: "Indicators",
    route: chatThreadsContract.indicators,
  },
  { name: "agents", response: "Agents", route: agentsMainContract.list },
  { name: "projects", response: "Projects", route: projectsContract.list },
];

export const kotlinFixtureTypes: readonly KotlinTypeBinding[] = [
  ...kotlinFixtureRoutes.map(({ response, route }) => {
    return {
      name: response,
      schema: route.responses[200]!,
      direction: "output" as const,
    };
  }),
  {
    name: "ChatArchive",
    schema: chatThreadSnapshotArchiveSchema,
    direction: "input",
  },
  {
    name: "IndicatorMap",
    schema: chatThreadsContract.indicators.responses[200].shape.threads,
    direction: "output",
  },
];

const threadId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const date = "2026-11-13T00:00:00.000Z";
const event = {
  id: eventId,
  seqId: 17,
  kind: "created",
  chatThreadId: threadId,
  agentId,
  title: null,
  selectedModel: null,
  serviceTier: null,
  computerUseHostId: null,
  modelSettings: {
    "claude-code/test": { effort: "extra" },
    "codex/test": { effort: "ultra" },
  },
  createdAt: date,
};

function wire(schema: ZodType, value: unknown): unknown {
  // Validate but preserve original wire, including documented input transforms.
  schema.parse(value);
  return value;
}

export function kotlinFixtureJson(): string {
  return (
    JSON.stringify(
      {
        snapshotRemote: wire(chatThreadsContract.snapshot.responses[200], {
          url: "https://storage.example/chat-snapshot",
          expiresInSeconds: 60,
          latestEventId: eventId,
          latestSeqId: 17,
        }),
        snapshotEmpty: wire(chatThreadsContract.snapshot.responses[200], {
          chatThreads: [],
          latestEventId: null,
          latestSeqId: null,
        }),
        events: wire(chatThreadsContract.events.responses[200], {
          events: [
            event,
            {
              ...event,
              id: "55555555-5555-4555-8555-555555555555",
              seqId: 23,
              kind: "project_updated",
              projectId: null,
            },
          ],
          hasMore: false,
        }),
        indicators: wire(chatThreadsContract.indicators.responses[200], {
          agents: { [agentId]: "active" },
          threads: { [threadId]: "unread" },
          unreadAt: { [threadId]: date },
        }),
        agents: wire(agentsMainContract.list.responses[200], [
          {
            agentId,
            isDefaultAgent: true,
            ownerId: "user_fixture",
            description: null,
            displayName: "My Okou",
            sound: null,
            avatarUrl: null,
            visibility: "private",
          },
        ]),
        projects: wire(projectsContract.list.responses[200], {
          projects: [
            {
              id: projectId,
              name: "A project",
              createdAt: date,
              updatedAt: date,
            },
          ],
        }),
        archive: wire(chatThreadSnapshotArchiveSchema, {
          chatThreads: [
            {
              id: threadId,
              agentId,
              projectId,
              title: "Saved conversation",
              sortAt: date,
              createdAt: date,
              updatedAt: date,
              pinnedAt: null,
              archived: false,
              renamedAt: null,
              serviceTier: "ultrafast",
              modelSettings: { "claude-code/test": { effort: "ultracode" } },
            },
          ],
        }),
      },
      null,
      2,
    ) + "\n"
  );
}
