import { cleanup, render } from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import type { Root } from "hast";
import { describe, test } from "vitest";

import { parseMarkdownTree } from "../../../../lib/markdown/pipeline.ts";
import {
  chatEventTreeContent,
  chatEventTreePlan,
} from "../../../../signals/chat-page/chat-event-body-blocks.ts";
import type { ChatEvent } from "../../../../signals/chat-page/chat-event-types.ts";
import {
  createImageLoadSignals,
  embedImageLoadSignals,
} from "../../../../signals/image-load.ts";
import {
  createMermaidDiagramRegistry,
  embedMermaidSignals,
} from "../../../../signals/mermaid-diagram.ts";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";
import { Markdown, MarkdownEventBody } from "../../rich-markdown.tsx";

// ---------------------------------------------------------------------------
// Chat markdown pipeline benchmarks.
//
// The transcript pays two separable costs: parsing an event's body into its
// tree (once per content, inside the ensure command) and rendering that tree
// (on every React render). These benches track both against a synthetic
// thread shaped like a real agent run: mostly short progress lines, a few
// table-heavy reports, one long prose message.
// ---------------------------------------------------------------------------

const context = testContext();

// The parse pass registers each diagram source with the surface's registry,
// which only hands back the signals to embed; layout happens later, when the
// render window prepares what it shows. These benches cover the parse pass.
const mermaidDiagrams = createMermaidDiagramRegistry();

function progressMessage(index: number): string {
  return [
    `Working on step ${String(index)} — **updated** \`module-${String(index)}.ts\`,`,
    `ran \`pnpm check --scope ${String(index)}\` and 校验了输出（第 ${String(index)} 步）。`,
    `See [the diff](https://example.com/diff/${String(index)}) for details.`,
  ].join(" ");
}

function markdownTable(rows: number, columns: number): string {
  const header = `| ${Array.from({ length: columns }, (_, column) => {
    return `Column ${String(column)}`;
  }).join(" | ")} |`;
  const separator = `| ${Array.from({ length: columns }, () => {
    return "---";
  }).join(" | ")} |`;
  const body = Array.from({ length: rows }, (_, row) => {
    return `| ${Array.from({ length: columns }, (_, column) => {
      return `\`r${String(row)}c${String(column)}\``;
    }).join(" | ")} |`;
  });
  return [header, separator, ...body].join("\n");
}

function codeBlock(lines: number): string {
  const body = Array.from({ length: lines }, (_, index) => {
    return `const value${String(index)} = compute(${String(index)}, "literal");`;
  }).join("\n");
  return `\`\`\`ts\n${body}\n\`\`\``;
}

function paragraphs(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    return `Paragraph ${String(index)} with **bold**, _italic_, \`code\` and a [link](https://example.com/${String(index)}) plus 一些中文内容（含全角标点）**加粗**后面。`;
  }).join("\n\n");
}

/** ~11 KB, three tables plus prose and code — the report-message shape. */
function reportMessage(): string {
  return [
    "# Run report",
    paragraphs(4),
    markdownTable(20, 6),
    paragraphs(2),
    markdownTable(20, 6),
    codeBlock(30),
    markdownTable(20, 6),
    "> Summary: all checks passed.",
    "- item one\n- item two\n- item three",
  ].join("\n\n");
}

const SHORT_MESSAGE = progressMessage(7);
const REPORT_MESSAGE = reportMessage();
const LONG_PROSE = paragraphs(40);

/** 98 messages: reports at 30/63/97, long prose at 50, progress elsewhere. */
const THREAD: readonly string[] = Array.from({ length: 98 }, (_, index) => {
  if (index === 30 || index === 63 || index === 97) {
    return REPORT_MESSAGE;
  }
  if (index === 50) {
    return LONG_PROSE;
  }
  return progressMessage(index);
});
const THREAD_TAIL = THREAD.slice(-10);

/** What the ensure command does per event: parse + embed prepared signals. */
function prepareTree(source: string): Root {
  const tree = parseMarkdownTree(source, { mermaid: true });
  embedMermaidSignals(tree, (code) => {
    return context.store.set(mermaidDiagrams.register$, code);
  });
  embedImageLoadSignals(tree, createImageLoadSignals);
  return tree;
}

function renderTree(tree: Root): void {
  render(
    <StoreProvider value={context.store}>
      <MarkdownEventBody tree={tree} mediaPreview />
    </StoreProvider>,
  );
  cleanup();
}

const CASES: readonly {
  readonly name: string;
  readonly sources: readonly string[];
}[] = [
  {
    name: `report message (${String(REPORT_MESSAGE.length)} chars, tables)`,
    sources: [REPORT_MESSAGE],
  },
  {
    name: `long prose (${String(LONG_PROSE.length)} chars)`,
    sources: [LONG_PROSE],
  },
  {
    name: `short progress message (${String(SHORT_MESSAGE.length)} chars)`,
    sources: [SHORT_MESSAGE],
  },
  {
    name: `thread tail (10 messages)`,
    sources: THREAD_TAIL,
  },
];

describe.each(CASES)("$name", ({ sources }) => {
  test("parse (once per content, ensure command)", async ({ bench }) => {
    await bench("parse (once per content, ensure command)", () => {
      for (const source of sources) {
        prepareTree(source);
      }
    }).run();
  });
  test("render from prepared tree (every render)", async ({ bench }) => {
    const trees = sources.map(prepareTree);
    await bench("render from prepared tree (every render)", () => {
      for (const tree of trees) {
        renderTree(tree);
      }
    }).run();
  });
});

describe("thread switch parse volume", () => {
  test(`full thread (${String(THREAD.length)} messages)`, async ({ bench }) => {
    await bench(`full thread (${String(THREAD.length)} messages)`, () => {
      for (const source of THREAD) {
        prepareTree(source);
      }
    }).run();
  });
  test("visible window only (tail 10 messages)", async ({ bench }) => {
    await bench("visible window only (tail 10 messages)", () => {
      for (const source of THREAD_TAIL) {
        prepareTree(source);
      }
    }).run();
  });
});

// ---------------------------------------------------------------------------
// Tree cache behavior. `ensureEventTrees$` runs after every write that can
// change the visible window — including scroll captures — so its unchanged
// path must cost a content lookup per event. These benches mirror that loop
// (minus card registries; this thread has no cards) over real ChatEvents.
// ---------------------------------------------------------------------------

const THREAD_ID = "bench-thread";

function assistantEvent(index: number, content: string): ChatEvent {
  return {
    id: `event-${String(index)}`,
    threadId: THREAD_ID,
    eventType: "output.message",
    content,
    seqId: index + 1,
    createdAt: "2026-08-12T00:00:00.000Z",
  };
}

const THREAD_EVENTS: readonly ChatEvent[] = THREAD.map((content, index) => {
  return assistantEvent(index, content);
});

interface CachedEventTree {
  readonly content: string;
  readonly tree: Root;
}

function ensurePass(
  events: readonly ChatEvent[],
  cache: ReadonlyMap<string, CachedEventTree>,
): ReadonlyMap<string, CachedEventTree> {
  let next: Map<string, CachedEventTree> | undefined;
  for (const event of events) {
    const content = chatEventTreeContent(event);
    if (content === null || cache.get(event.id)?.content === content) {
      continue;
    }
    const plan = chatEventTreePlan(event, {
      agentId: "c0000000-0000-4000-a000-000000000001",
      threadId: THREAD_ID,
    });
    if (plan === null) {
      continue;
    }
    const tree = parseMarkdownTree(plan.treeSource, {
      mermaid: true,
    });
    embedMermaidSignals(tree, (code) => {
      return context.store.set(mermaidDiagrams.register$, code);
    });
    embedImageLoadSignals(tree, createImageLoadSignals);
    next ??= new Map(cache);
    next.set(event.id, { content: plan.content, tree });
  }
  return next ?? cache;
}

describe("ensure pass over the event tree cache", () => {
  const streamingEvents: readonly ChatEvent[] = [
    ...THREAD_EVENTS.slice(0, -1),
    assistantEvent(
      THREAD_EVENTS.length - 1,
      `${REPORT_MESSAGE}\n\nOne more streamed paragraph.`,
    ),
  ];
  test(`unchanged thread (${String(THREAD_EVENTS.length)} events, scroll capture path)`, async ({
    bench,
  }) => {
    const warmCache = ensurePass(THREAD_EVENTS, new Map());
    await bench(
      `unchanged thread (${String(THREAD_EVENTS.length)} events, scroll capture path)`,
      () => {
        ensurePass(THREAD_EVENTS, warmCache);
      },
    ).run();
  });
  test("streaming delta (re-parses only the growing report message)", async ({
    bench,
  }) => {
    const warmCache = ensurePass(THREAD_EVENTS, new Map());
    await bench(
      "streaming delta (re-parses only the growing report message)",
      () => {
        ensurePass(streamingEvents, warmCache);
      },
    ).run();
  });
});

// The 8 surfaces still on `Markdown({source})` parse inside render. Contrast
// with "render from prepared tree" on the same report message to price the
// pending migration.
describe("standalone Markdown (parse-in-render surfaces)", () => {
  test(`report message (${String(REPORT_MESSAGE.length)} chars, parses per render)`, async ({
    bench,
  }) => {
    await bench(
      `report message (${String(REPORT_MESSAGE.length)} chars, parses per render)`,
      () => {
        render(
          <StoreProvider value={context.store}>
            <Markdown source={REPORT_MESSAGE} mediaPreview />
          </StoreProvider>,
        );
        cleanup();
      },
    ).run();
  });
});
