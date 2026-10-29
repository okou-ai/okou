import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createSuggestionCommand } from "../index";
import {
  SUGGESTION_MEMORY_PATH,
  suggestionMemorySchema,
  emptySuggestionMemory,
} from "@okouai/api-contracts/contracts/suggestion-memory";
import type { SuggestionFeedback } from "@okouai/api-contracts/contracts/suggestions";

const id = "a0000000-0000-4000-a000-000000000001";
const content = {
  id,
  title: "Review the launch",
  rationale: "A decision is pending",
  priority: 20,
  feedbackScope: { key: "project-review", label: "project review" },
  customOption: {
    id: "custom",
    threadId: null,
    draft: {
      draftUserMessage: {
        version: 1,
        parts: [
          {
            type: "feedback",
            quote:
              "Launch background: source launch-plan-v2. Budget and owner are not confirmed.",
            note: [],
          },
        ],
      },
      draftAttachments: null,
    },
  },
  options: [
    {
      id: "default",
      label: "Review the launch",
      description: "A decision is pending",
      threadId: null,
      draft: {
        draftUserMessage: {
          version: 1,
          parts: [{ type: "text", text: "Review the launch plan." }],
        },
        draftAttachments: null,
      },
    },
  ],
};
const item = {
  ...content,
  status: "active",
  selectedOptionId: null,
  feedbacks: [],
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
};
const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});
beforeEach(() => {
  vi.stubEnv("OKOU_TOKEN", "test-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
});
const run = (...args: string[]) => {
  return createSuggestionCommand().parseAsync(["node", "okou", ...args]);
};

it("derives the same action identity across checks and a different identity for a new event", async () => {
  await run(
    "identity",
    "--key",
    "github:okou-ai/okou:pr:123:review:head-1",
    "--json",
  );
  const first = log.mock.calls.at(-1)?.[0];
  expect(first).toEqual(
    expect.stringMatching(
      /^\{"id":"[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\}$/u,
    ),
  );
  await run(
    "identity",
    "--key",
    "github:okou-ai/okou:pr:123:review:head-1",
    "--json",
  );
  expect(log.mock.calls.at(-1)?.[0]).toBe(first);
  await run(
    "identity",
    "--key",
    "github:okou-ai/okou:pr:123:review:head-2",
    "--json",
  );
  expect(log.mock.calls.at(-1)?.[0]).not.toBe(first);
});

it("publishes a canonical draft from a real file with a stable creation identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "suggestion-test-"));
  try {
    const path = join(directory, "suggestion.json");
    await writeFile(path, JSON.stringify(content));
    server.use(
      http.post(
        "http://localhost:3000/api/suggestions",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          expect(await request.json()).toEqual(content);
          return HttpResponse.json(item);
        },
      ),
    );
    await run("create", "--file", path, "--json");
    expect(log).toHaveBeenCalledWith(JSON.stringify(item));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("converts convenient text input into the same saved composer format", async () => {
  server.use(
    http.post("http://localhost:3000/api/suggestions", async ({ request }) => {
      expect(await request.json()).toMatchObject({
        id,
        priority: 0,
        options: [
          {
            ...content.options[0],
            description: "",
          },
        ],
      });
      return HttpResponse.json({ ...item, priority: 0 });
    }),
  );
  await run(
    "create",
    "--id",
    id,
    "--title",
    content.title,
    "--feedback-scope",
    "project-review",
    "--feedback-label",
    "project review",
    "--text",
    "Review the launch plan.",
    "--background",
    "Launch background: source launch-plan-v2. Budget and owner are not confirmed.",
    "--json",
  );
  expect(log).toHaveBeenCalledWith(JSON.stringify({ ...item, priority: 0 }));
});
it("rejects structured input mixed with field flags instead of silently publishing the file's priority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "suggestion-test-"));
  try {
    const path = join(directory, "suggestion.json");
    await writeFile(path, JSON.stringify(content));
    server.use(
      http.post("http://localhost:3000/api/suggestions", () => {
        return HttpResponse.json(item);
      }),
    );
    await expect(
      run("create", "--file", path, "--priority", "90", "--json"),
    ).rejects.toThrow("process.exit called");
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        error: {
          code: "INVALID_INPUT",
          message: "Use --file or text input fields, not both.",
        },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("updates one priority without requiring a file or other suggestions' positions", async () => {
  server.use(
    http.patch(
      `http://localhost:3000/api/suggestions/${id}`,
      async ({ request }) => {
        expect(await request.json()).toEqual({ priority: 90 });
        return HttpResponse.json({ ...item, priority: 90 });
      },
    ),
  );
  await run("update", id, "--priority", "90", "--json");
  expect(log).toHaveBeenCalledWith(JSON.stringify({ ...item, priority: 90 }));
});
it("publishes and updates multiple action options without changing their identities or drafts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "suggestion-test-"));
  const options = [
    ...content.options,
    {
      ...content.options[0],
      id: "prepare",
      label: "Prepare a reply",
      description: "Draft a reply for review",
      threadId: "b0000000-0000-4000-a000-000000000001",
      draft: {
        draftUserMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Prepare a reply without sending it." },
          ],
        },
        draftAttachments: null,
      },
    },
  ];
  const reordered = [...options].reverse();
  try {
    const path = join(directory, "suggestion.json");
    const updated = { ...item, options };
    server.use(
      http.post(
        "http://localhost:3000/api/suggestions",
        async ({ request }) => {
          expect(await request.json()).toEqual({ ...content, options });
          return HttpResponse.json(updated);
        },
      ),
      http.patch(
        `http://localhost:3000/api/suggestions/${id}`,
        async ({ request }) => {
          expect(await request.json()).toEqual({
            options: reordered,
          });
          return HttpResponse.json({
            ...updated,
            options: reordered,
          });
        },
      ),
    );
    await writeFile(path, JSON.stringify({ ...content, options }));
    await run("create", "--file", path, "--json");
    expect(log).toHaveBeenLastCalledWith(JSON.stringify(updated));
    await writeFile(path, JSON.stringify({ options: reordered }));
    await run("update", id, "--file", path, "--json");
    expect(log).toHaveBeenLastCalledWith(
      JSON.stringify({ ...updated, options: reordered }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("prints structured capacity errors with the API's next-action guidance", async () => {
  server.use(
    http.post("http://localhost:3000/api/suggestions", () => {
      return HttpResponse.json(
        {
          error: {
            code: "CONFLICT",
            message: "The pool contains ten suggestions. Delete an item first.",
          },
        },
        { status: 409 },
      );
    }),
  );
  await expect(
    run(
      "create",
      "--id",
      id,
      "--title",
      content.title,
      "--feedback-scope",
      "project-review",
      "--feedback-label",
      "project review",
      "--text",
      "Review the launch plan.",
      "--background",
      "Complete neutral launch background",
      "--json",
    ),
  ).rejects.toThrow("process.exit called");
  expect(error).toHaveBeenCalledWith(
    JSON.stringify({
      error: {
        code: "CONFLICT",
        message: "The pool contains ten suggestions. Delete an item first.",
      },
    }),
  );
});
it("withdraws a suggestion through the delete command and prints its receipt", async () => {
  server.use(
    http.delete(`http://localhost:3000/api/suggestions/${id}`, () => {
      return new HttpResponse(null, { status: 204 });
    }),
  );
  await run("delete", id, "--json");
  expect(log).toHaveBeenCalledWith(JSON.stringify({ id, removed: true }));
});
it("lists the active pool and terminal receipts as machine-readable JSON", async () => {
  const response = {
    suggestions: [item],
    receipts: [
      {
        id: "a0000000-0000-4000-a000-000000000002",
        status: "consumed",
        selectedOptionId: null,
        feedbacks: [],
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      },
    ],
  };
  server.use(
    http.get("http://localhost:3000/api/suggestions", () => {
      return HttpResponse.json(response);
    }),
  );
  await run("list", "--json");
  expect(log).toHaveBeenCalledWith(JSON.stringify(response));
});
it("rejects text publication without a stable UUID before making a request", async () => {
  await expect(
    run(
      "create",
      "--title",
      content.title,
      "--text",
      "Review the launch plan.",
      "--background",
      "Complete neutral launch background",
      "--json",
    ),
  ).rejects.toThrow("process.exit called");
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining('"code":"INVALID_INPUT"'),
  );
});

it("requires an explicit neutral background for convenient text input", async () => {
  await expect(
    run(
      "create",
      "--id",
      id,
      "--title",
      content.title,
      "--text",
      "Draft the reply",
      "--json",
    ),
  ).rejects.toThrow("process.exit called");
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining(
      "Provide --background with the complete neutral context",
    ),
  );
});

it("learns 7-day action facts and 30-day preferences without renewing them on replay, and applies reasons and undo", async () => {
  const directory = await mkdtemp(join(tmpdir(), "suggestion-memory-"));
  const at = new Date(Date.now() - 60_000).toISOString();
  const actionId = randomUUID();
  const preferenceId = randomUUID();
  const context = {
    title: content.title,
    rationale: content.rationale,
    scope: content.feedbackScope,
    optionLabel: null,
  };
  const action: SuggestionFeedback = {
    id: actionId,
    kind: "already_done",
    createdAt: at,
    learnedAt: null,
    targetId: null,
    note: "",
    context,
  };
  const preference: SuggestionFeedback = {
    ...action,
    id: preferenceId,
    kind: "less_like_this",
  };
  let feedbacks = [action, preference];
  let publishedMemory = emptySuggestionMemory();
  server.use(
    http.post("http://localhost:3000/api/suggestions/learning", () => {
      return HttpResponse.json({
        memory: publishedMemory,
        pending: [{ suggestionId: id, feedbacks }],
      });
    }),
  );
  const read = async () => {
    return suggestionMemorySchema.parse(
      JSON.parse(
        await readFile(join(directory, SUGGESTION_MEMORY_PATH), "utf8"),
      ),
    );
  };
  try {
    await run("learning", "--memory-root", directory, "--json");
    const first = await read();
    expect(first.records).toHaveLength(2);
    expect(
      first.records.flatMap((record) => {
        return record.evidence.map((evidence) => {
          return [evidence.kind, evidence.expiresAt];
        });
      }),
    ).toEqual(
      expect.arrayContaining([
        [
          "already_done",
          new Date(Date.parse(at) + 7 * 86_400_000).toISOString(),
        ],
        [
          "less_like_this",
          new Date(Date.parse(at) + 30 * 86_400_000).toISOString(),
        ],
      ]),
    );
    await run("learning", "--memory-root", directory, "--json");
    expect(await read()).toEqual(first);
    publishedMemory = first;
    feedbacks = [
      {
        ...preference,
        id: randomUUID(),
        kind: "reason",
        targetId: preferenceId,
        note: "Someone else handles these reviews",
      },
    ];
    await run("learning", "--memory-root", directory, "--read-only", "--json");
    expect(await read()).toEqual(first);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("Someone else handles these reviews"),
    );
    await run("learning", "--memory-root", directory, "--json");
    expect(
      (await read()).records.find((record) => {
        return record.id.startsWith("preference:");
      })?.evidence,
    ).toEqual([
      expect.objectContaining({
        id: preferenceId,
        note: "Someone else handles these reviews",
        expiresAt: new Date(Date.parse(at) + 30 * 86_400_000).toISOString(),
      }),
    ]);
    feedbacks = [
      { ...preference, id: randomUUID(), kind: "undo", targetId: preferenceId },
    ];
    await run("learning", "--memory-root", directory, "--json");
    expect(
      (await read()).records.map((record) => {
        return record.id;
      }),
    ).toEqual([`action:${id}`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses newly published feedback even when this Run mounted an older Memory candidate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "suggestion-memory-head-"));
  const file = join(directory, SUGGESTION_MEMORY_PATH);
  let memory = emptySuggestionMemory();
  server.use(
    http.post("http://localhost:3000/api/suggestions/learning", () => {
      return HttpResponse.json({ memory, pending: [] });
    }),
  );
  try {
    await run("learning", "--memory-root", directory, "--json");
    const original = await readFile(file, "utf8");
    const observedAt = new Date().toISOString();
    memory = {
      schemaVersion: 1,
      records: [
        {
          id: "preference:project-review",
          title: "Published preference context",
          rationale: content.rationale,
          scope: content.feedbackScope,
          evidence: [
            {
              id: randomUUID(),
              suggestionId: id,
              kind: "less_like_this",
              observedAt,
              expiresAt: new Date(
                Date.parse(observedAt) + 30 * 86_400_000,
              ).toISOString(),
              note: "",
              optionLabel: null,
            },
          ],
        },
      ],
      processedFeedback: [],
    };
    await run("learning", "--memory-root", directory, "--read-only", "--json");
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("Published preference context"),
    );
    expect(await readFile(file, "utf8")).toEqual(original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("expires old feedback and bounds the member Memory file while retaining the processed batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "suggestion-memory-cap-"));
  const at = new Date(Date.now() - 60_000).toISOString();
  const feedbacks = Array.from({ length: 100 }, (_, index) => {
    return {
      suggestionId: randomUUID(),
      feedbacks: [
        {
          id: randomUUID(),
          kind: "not_planned",
          targetId: null,
          learnedAt: null,
          createdAt: at,
          note: "n".repeat(512),
          context: {
            title: "t".repeat(120),
            rationale: "r".repeat(200),
            scope: { key: `type-${index}`, label: "Review" },
            optionLabel: null,
          },
        },
      ],
    };
  });
  let pending = feedbacks;
  server.use(
    http.post("http://localhost:3000/api/suggestions/learning", () => {
      return HttpResponse.json({ memory: emptySuggestionMemory(), pending });
    }),
  );
  try {
    await run("learning", "--memory-root", directory, "--json");
    const bytes = await readFile(join(directory, SUGGESTION_MEMORY_PATH));
    const memory = suggestionMemorySchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    expect(bytes.length).toBeLessThanOrEqual(65_536);
    expect(memory.records.length).toBeLessThanOrEqual(100);
    expect(memory.processedFeedback).toHaveLength(100);
    await rm(join(directory, SUGGESTION_MEMORY_PATH));
    const sample = feedbacks.at(0)?.feedbacks.at(0);
    if (!sample) throw new Error("Expected feedback fixture");
    pending = [
      {
        suggestionId: id,
        feedbacks: [
          {
            ...sample,
            id: randomUUID(),
            createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
          },
        ],
      },
    ];
    await run("learning", "--memory-root", directory, "--json");
    expect(
      suggestionMemorySchema.parse(
        JSON.parse(
          await readFile(join(directory, SUGGESTION_MEMORY_PATH), "utf8"),
        ),
      ).records,
    ).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reads management pages beyond the homepage cap and forwards the continuation", async () => {
  server.use(
    http.get("http://localhost:3000/api/suggestions/active", ({ request }) => {
      expect(new URL(request.url).searchParams.get("after")).toBe(id);
      return HttpResponse.json({
        suggestions: [item],
        receipts: [],
        nextAfter: null,
      });
    }),
  );
  await run("list", "--all", "--after", id, "--json");
  expect(log).toHaveBeenLastCalledWith(
    JSON.stringify({ suggestions: [item], receipts: [], nextAfter: null }),
  );
});

it.each(["already_done", "less_like_this"] as const)(
  "scopes %s revisions to one card when two cards share a feedback identity",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "suggestion-memory-scope-"));
    const otherId = randomUUID();
    const sharedId = randomUUID();
    const at = new Date().toISOString();
    const feedback: SuggestionFeedback = {
      id: sharedId,
      kind,
      createdAt: at,
      learnedAt: null,
      targetId: null,
      note: "",
      context: {
        title: content.title,
        rationale: content.rationale,
        scope: content.feedbackScope,
        optionLabel: null,
      },
    };
    let memory = emptySuggestionMemory();
    let pending = [
      { suggestionId: id, feedbacks: [feedback] },
      { suggestionId: otherId, feedbacks: [feedback] },
    ];
    server.use(
      http.post("http://localhost:3000/api/suggestions/learning", () => {
        return HttpResponse.json({ memory, pending });
      }),
    );
    try {
      await run("learning", "--memory-root", directory, "--json");
      memory = suggestionMemorySchema.parse(
        JSON.parse(
          await readFile(join(directory, SUGGESTION_MEMORY_PATH), "utf8"),
        ),
      );
      expect(
        memory.records.flatMap((record) => {
          return record.evidence;
        }),
      ).toHaveLength(2);
      pending = [
        {
          suggestionId: id,
          feedbacks: [
            { ...feedback, id: randomUUID(), kind: "undo", targetId: sharedId },
          ],
        },
      ];
      await run("learning", "--memory-root", directory, "--json");
      const after = suggestionMemorySchema.parse(
        JSON.parse(
          await readFile(join(directory, SUGGESTION_MEMORY_PATH), "utf8"),
        ),
      );
      expect(
        after.records.flatMap((record) => {
          return record.evidence;
        }),
      ).toEqual([expect.objectContaining({ suggestionId: otherId })]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
