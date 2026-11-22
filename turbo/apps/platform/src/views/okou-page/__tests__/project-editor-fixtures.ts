import {
  projectsContract,
  type Project,
  type ProjectEvent,
} from "@okouai/api-contracts/contracts/projects";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { chatListThread } from "./chat-list-test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { waitFor } from "@testing-library/react";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";

const timestamp = "2026-06-09T10:00:00.000Z";
export function project(name: string): Project {
  return {
    name,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
export async function projectEditor(
  context: TestContext,
  projects: Project[],
  options: {
    path?: string;
    createGate?: Promise<void>;
    renameGate?: Promise<void>;
    onDelete?: () => Promise<"fail" | "ok">;
    confirmedName?: string;
  } = {},
) {
  const ordinary = chatListThread(811, "Existing conversation");
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 719,
    threads: [ordinary],
  });
  const copied = projects.map((p) => {
    return { ...p };
  });
  const events: ProjectEvent[] = [];
  function record(
    id: string,
    projectId: string,
    name: string | null,
    kind: ProjectEvent["kind"],
  ) {
    events.push({
      id,
      seqId: events.length + 1,
      projectId,
      name,
      kind,
      createdAt: timestamp,
    });
  }
  const created = context.mocks.deferred<{
    id: string;
    project: string | null;
  }>();
  const sent = context.mocks.deferred<string>();
  const creating = context.mocks.deferred<string>();
  mockChatLifecycle(context, {
    threadId: ordinary.id,
    onSendRequest: (body) => {
      return sent.resolve(body.prompt);
    },
  });
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: projects,
      latestEventId: null,
      latestSeqId: 0,
    });
  });
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((e) => {
        return e.seqId > query.sinceSeqId;
      }),
      hasMore: false,
    });
  });
  context.mocks.api(projectsContract.threads, ({ respond }) => {
    return respond(200, { threads: [], nextAfter: null });
  });
  context.mocks.api(projectsContract.create, async ({ body, respond }) => {
    creating.resolve(body.id);
    await options.createGate;
    const newProject = {
      ...project(options.confirmedName ?? body.name),
      id: body.id,
    };
    copied.push(newProject);
    record(body.eventId, body.id, newProject.name, "created");
    return respond(201, newProject);
  });
  context.mocks.api(
    projectsContract.update,
    async ({ params, body, respond }) => {
      await options.renameGate;
      const item = copied.find((p) => {
        return p.id === params.id;
      })!;
      item.name = options.confirmedName ?? body.name;
      record(body.eventId, params.id, item.name, "renamed");
      return respond(200, item);
    },
  );
  context.mocks.api(
    projectsContract.delete,
    async ({ params, body, respond }) => {
      if ((await options.onDelete?.()) === "fail") {
        return respond(409, {
          error: {
            code: "CONFLICT",
            message: "Please retry removing this project",
          },
        });
      }
      record(body.eventId, params.id, null, "deleted");
      copied.splice(
        copied.findIndex((p) => {
          return p.id === params.id;
        }),
        1,
      );
      return respond(204);
    },
  );
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    const id = body.clientThreadId!;
    created.resolve({ id, project: body.projectId ?? null });
    return respond(201, {
      id,
      projectId: body.projectId ?? null,
      title: body.title ?? null,
      createdAt: timestamp,
      selectedModel: body.model ?? null,
      serviceTier: null,
    });
  });
  await setupPage({
    context,
    ...pageOptions,
    path:
      options.path === "chat" ? "/chats/" + ordinary.id : (options.path ?? "/"),
  });
  return {
    created: created.promise,
    sent: sent.promise,
    creating: creating.promise,
    ordinary: ordinary.id,
  };
}
export async function chooseProject(name: string) {
  await clickComposerAddMenuItem("Project");
  click(await projectMenuItem(name));
}

export function projectMenuItem(name: string) {
  return waitFor(() => {
    const item = queryAllByRoleFast("menuitem").find((row) => {
      return row.textContent?.trim() === name;
    });
    if (!item) {
      throw new Error("Missing project action " + name);
    }
    return item;
  });
}
