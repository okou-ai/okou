import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createSuggestionCommand } from "../index";

const id = "a0000000-0000-4000-a000-000000000001";
const content = {
  id,
  title: "Review the launch",
  rationale: "A decision is pending",
  priority: 20,
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
