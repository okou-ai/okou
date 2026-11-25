import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  getAction,
  findAction,
} from "./connector-integrations-test-helpers.ts";
import {
  setupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedMarkdownReply,
  createMarkdownChatFixture,
} from "./markdown-page-test-helpers.ts";
import { connectorAccountFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  googleDriveCatalogItem,
  artifactSummary,
  fileArtifactDetail,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  mockOAuthCompletions,
  mockSavedConnectorAccounts,
} from "./connector-page-test-helpers.ts";
import { HttpResponse } from "msw";
import { strFromU8, unzipSync } from "fflate";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import userEvent from "@testing-library/user-event";
import {
  createChatRunFixtures,
  RUN_PATH,
  assistantEvent,
  promptEvent,
  completedEvent,
} from "./chat-run-test-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();

function read(markdown: string) {
  return setupPage({
    context,
    path: completedMarkdownReply(context, markdown),
  });
}

test("markdown-content-001 a quoted instruction preserves its literal markup", async () => {
  await read("> Before signing, inspect <widget>carefully</widget>.");
  const quote = await screen.findByText(/Before signing, inspect/, {
    selector: "blockquote p",
  });
  expect(quote).toBeVisible();
  expect(quote.textContent).toBe(
    "Before signing, inspect <widget>carefully</widget>.",
  );
});

test("markdown-content-002 a completed checklist keeps its formatting and comparison table", async () => {
  await read(
    "**Urgent** *review* ~~obsolete~~\n\n- [x] Signed\n\n| Team | Reviewer |\n|---|---|\n| Finance | Mila |",
  );
  await screen.findByText("Mila", { selector: "td" });
  for (const [selector, word] of [
    ["strong", "Urgent"],
    ["em", "review"],
    ["del", "obsolete"],
  ]) {
    expect(screen.getByText(word, { selector })).toBeVisible();
  }
  const grid = screen.getByRole("table");
  expect(
    Array.from(grid.querySelectorAll("th")).map((cell) => {
      return cell.textContent;
    }),
  ).toStrictEqual(["Team", "Reviewer"]);
  expect(
    Array.from(grid.querySelectorAll("td")).map((cell) => {
      return cell.textContent;
    }),
  ).toStrictEqual(["Finance", "Mila"]);
  expect(screen.getByRole("checkbox")).toBeChecked();
});
test("markdown-content-003 three contact formats preserve their mail recipients", async () => {
  const links = [
    ["ops@example.org", "mailto:ops@example.org"],
    ["Editor", "mailto:ed@example.org"],
    ["Review group", "mailto:ann@example.org,lee@example.org?subject=Draft"],
  ];
  await read(
    "Contact ops@example.org, [Editor](mailto:ed@example.org), or [Review group](mailto:ann@example.org,lee@example.org?subject=Draft).",
  );
  for (const [name, href] of links) {
    const link = await findAction("link", name);
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")?.split(" ")).toStrictEqual(
      expect.arrayContaining(["noopener", "noreferrer"]),
    );
  }
});
test("markdown-content-004 a six-digit color retains the written value next to its swatch", async () => {
  await read("Apply #12ABef to the shipping label.");
  await screen.findByText(/shipping label/);
  const marker = document.querySelector(
    '[data-markdown-color-preview="#12ABef" i]',
  );
  expect(marker).toBeVisible();
  expect(screen.getByText(/shipping label/)).toHaveTextContent("#12ABef");
});
test("markdown-content-006 the image loads alongside separate media links", async () => {
  const poster = "https://cdn.example.org/assets/poster.png",
    clip = "https://cdn.example.org/assets/clip.mp4";
  await read(
    "[Poster file](" +
      poster +
      ") ![Spring poster](" +
      poster +
      ") [Watch clip](" +
      clip +
      ")",
  );
  const img = await screen.findByRole("img", { name: "Spring poster" });
  fireEvent.load(img);
  expect(img).toBeVisible();
  expect(img).toHaveAttribute("src", poster);
  expect(getAction("link", "Watch clip")).toHaveAttribute("href", clip);
  expect(getAction("link", "Poster file")).toHaveAttribute("href", poster);
});

test("Long bare URLs show a short label and retain their destination", async () => {
  const short = "https://example.com/".padEnd(80, "a");
  const long = short + "?callback=" + "b".repeat(200);
  const name = "Read the full document";
  await read([short, long, `[${name}](${long})`].join("\n\n"));

  const clipped = await findAction("link", long.slice(0, 77) + "...");
  expect(clipped).toHaveAttribute("href", long);
  expect(getAction("link", short)).toHaveAttribute("href", short);
  expect(getAction("link", name)).toHaveAttribute("href", long);
});

test("markdown-interactions-001 copying the second snippet leaves the first copy action untouched", async () => {
  const sample = 'const second = "beta";';
  const clipboard = context.mocks.browser.clipboardWriteText();
  const path = completedMarkdownReply(
    context,
    [
      "~~~typescript",
      'const first = "alpha";',
      "~~~",
      "",
      "~~~typescript",
      sample,
      "~~~",
    ].join("\n"),
  );
  await setupPage({ context, path });
  const buttons = await screen.findAllByLabelText("Copy to clipboard");
  expect(buttons).toHaveLength(2);
  click(buttons[1]);
  await waitFor(() => {
    return expect(buttons[1]).toHaveAccessibleName("Copied");
  });
  expect(buttons[0]).toHaveAccessibleName("Copy to clipboard");
  expect(clipboard.writes).toStrictEqual([sample + "\n"]);
});
test("markdown-interactions-003 run completion preserves one copy of each rich message element", async () => {
  const chat = createMarkdownChatFixture(context),
    runId = crypto.randomUUID();
  const text = [
    "# Ledger digest",
    "",
    "**Signed** and *reviewed*",
    "",
    "~~~typescript",
    "const total = 2;",
    "~~~",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> Quoted sum",
    "",
    "- open item",
    "",
    String.raw`\(x+2\) [Record][ref] ![Stable image](https://cdn.example.org/stable.png) <trial>literal</trial>`,
    "",
    "[ref]: https://example.org/record",
  ].join("\n");
  const rows = [
    chat.inputPrompt("Audit the digest", { seqId: 1, runId }),
    chat.outputMessage(text, { seqId: 2, runId }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });
  await setupPage({ context, path: chat.path });
  await screen.findByRole("heading", { name: "Ledger digest" });
  const checkDigest = () => {
    const reply = screen
      .getByRole("heading", { name: "Ledger digest" })
      .closest('[data-role="assistant"]');
    if (!reply) {
      throw new Error("Missing digest response");
    }
    for (const selector of [
      "h1",
      "strong",
      "em",
      "pre code",
      "table",
      "blockquote",
      "ul",
      'img[alt="Stable image"]',
    ]) {
      expect(reply.querySelectorAll(selector)).toHaveLength(1);
    }
    expect(reply.querySelector("annotation")?.textContent).toBe("x+2");
    expect(
      reply.querySelector('a[href="https://example.org/record"]'),
    ).toHaveTextContent("Record");
    expect(reply).toHaveTextContent("<trial>literal</trial>");
  };
  await screen.findByText("x+2", { selector: "annotation" });
  checkDigest();
  await expect(screen.findByLabelText("Stop")).resolves.toBeVisible();
  rows.push(chat.runCompleted({ seqId: 3, runId }));
  context.mocks.ably.trigger(chat.realtimeTopic);
  await waitFor(() => {
    return expect(screen.queryByLabelText("Stop")).toBeNull();
  });
  checkDigest();
});

async function table(text: string) {
  const runId = crypto.randomUUID();
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 1,
        text: "List the invoice totals",
      }),
      assistantEvent({ id: crypto.randomUUID(), runId, seqId: 2, text }),
      completedEvent({ id: crypto.randomUUID(), runId, seqId: 3 }),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
}
test("markdown-table-export-002 an empty single-column table keeps its export action", async () => {
  await table("| Invoice |\n| --- |");
  await screen.findByText("Invoice", { selector: "th" });
  await screen.findByText("0 rows · 1 column");
  await expect(findFastControl("button", "Export")).resolves.toBeEnabled();
});
test("markdown-table-export-013 keyboard export reveals both Google destinations and restores focus", async () => {
  await table("| Invoice |\n| --- |\n| March |");
  const trigger = await findFastControl("button", "Export");
  trigger.focus();
  await userEvent.keyboard("{ArrowDown}");
  const excel = await screen.findByText("Export Excel", {
    selector: '[role="menuitem"]',
  });
  await waitFor(() => {
    return expect(excel).toHaveFocus();
  });
  for (const name of ["Save to Google Drive", "Save to Google Sheets"]) {
    expect(
      screen.getByText(name, { selector: '[role="menuitem"]' }),
    ).toBeInTheDocument();
  }
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

const workbookType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const sheetsType = "application/vnd.google-apps.spreadsheet";
type SaveMode = "original" | "google";
function spreadsheetBoundary() {
  const fileId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const file = {
    id: fileId,
    filename: "Table.xlsx",
    size: 256,
    contentType: workbookType,
    url: "https://exports.example.test/" + fileId,
  };
  context.mocks.upload.success(file);
  context.mocks.api(uploadsContract.preparePrivate, ({ respond }) => {
    return respond(200, {
      ...file,
      uploadUrl: "https://mock-upload.r2.test/" + fileId,
      uploadHeaders: {},
    });
  });
  context.mocks.api(
    artifactReferencesContract.ownerArtifact,
    ({ params, respond }) => {
      expect(params.reference).toBe(fileId.replaceAll("-", "") + ".xlsx");
      return respond(200, { artifactId });
    },
  );
  const account = crypto.randomUUID();
  const access = { needsConnection: false };
  const detail = fileArtifactDetail(
    artifactSummary(artifactId, "file", "Weekly totals"),
    { fileId, ...file },
  );
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    expect(params.artifactId).toBe(artifactId);
    return respond(200, {
      ...detail,
      googleDriveConnectionId: access.needsConnection ? undefined : account,
      googleDriveSync: access.needsConnection
        ? { status: "disconnected", recovery: { action: "connect" } }
        : { status: "not_synced" },
    });
  });
  const destination = {
    links: { original: null, google: null } as Record<SaveMode, string | null>,
    convert: true,
    unavailable: false,
    ready: Promise.resolve(),
    started: context.mocks.deferred<void>(),
  };
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    async ({ params, body, respond }) => {
      expect(params.artifactId).toBe(artifactId);
      expect(body.connectionId).toBe(account);
      if (!destination.started.settled()) {
        destination.started.resolve();
      }
      await destination.ready;
      if (destination.unavailable) {
        return respond(503, {
          error: {
            code: "GOOGLE_DRIVE_UNAVAILABLE",
            message: "Google Drive is temporarily unavailable",
          },
        });
      }
      return respond(200, {
        id: "weekly-totals",
        name: "Table.xlsx",
        webViewLink: destination.links[body.mode],
        mimeType:
          body.mode === "google" && destination.convert
            ? sheetsType
            : workbookType,
      });
    },
  );
  return { destination, account, access };
}

async function saveTo(mode: SaveMode, trigger?: HTMLElement) {
  click(trigger ?? (await findFastControl("button", "Export")));
  const label =
    mode === "original" ? "Save to Google Drive" : "Save to Google Sheets";
  click(await screen.findByText(label, { selector: '[role="menuitem"]' }));
}
async function savedLink(mode: SaveMode, href: string) {
  await waitFor(() => {
    const link = queryAllByRoleFast("link", document.body).find((a) => {
      return a.getAttribute("href") === href;
    });
    expect(link).toBeInTheDocument();
    expect(link?.closest("li")).toHaveTextContent(
      mode === "original" ? "Saved to Google Drive" : "Saved to Google Sheets",
    );
  });
}
const forecast = "| Period | Amount |\n|---|---|\n| Spring | 28 |";
test.each([
  ["markdown-table-export-019", "original", "Save to Google Drive"],
  ["markdown-table-export-020", "google", "Save to Google Sheets"],
] as const)(
  "%s a repeated save offers the latest destination link",
  async (_id, mode, label) => {
    const { destination } = spreadsheetBoundary();
    destination.links[mode] = "https://docs.example.test/first-copy";
    await table(forecast);
    await saveTo(mode);
    await savedLink(mode, destination.links[mode]);
    destination.links[mode] = "https://docs.example.test/second-copy";
    await saveTo(mode);
    await savedLink(mode, destination.links[mode]);

    click(await findFastControl("button", "Export"));
    await expect(
      screen.findByText(label, {
        selector: '[role="menuitem"]',
      }),
    ).resolves.toBeEnabled();
  },
);

test("markdown-table-export-022 retrying a Sheets conversion produces a confirmed spreadsheet", async () => {
  const { destination } = spreadsheetBoundary();
  destination.links.original = "https://docs.example.test/original";
  await table(forecast);
  await saveTo("original");
  await savedLink("original", destination.links.original);
  destination.convert = false;
  await saveTo("google");
  await expect(
    screen.findByText(
      "Google conversion could not be confirmed. Check Drive before retrying.",
    ),
  ).resolves.toBeInTheDocument();
  destination.convert = true;
  destination.links.google = "https://docs.example.test/converted";
  await saveTo("google");
  await savedLink("google", destination.links.google);
});

test("markdown-table-export-025 a pending first upload leaves the second table available", async () => {
  const { destination } = spreadsheetBoundary();
  const held = context.mocks.deferred<void>();
  destination.ready = held.promise;
  destination.links.original = "https://docs.example.test/quarter";
  await table(
    forecast + "\n\n| Region | Owner |\n|---|---|\n| North | Rivera |",
  );
  await screen.findByText("Rivera", { selector: "td" });
  const [first, second] = queryAllByRoleFast("button", document.body).filter(
    (button) => {
      return button.getAttribute("aria-label") === "Export";
    },
  );
  await saveTo("original", first);
  await destination.started.promise;
  await findAction("button", "Saving…");
  expect(first).toHaveAccessibleName("Saving…");
  expect(first).toBeDisabled();
  expect(first).toHaveAttribute("aria-busy", "true");
  expect(second).toBeEnabled();
  expect(second).toHaveAccessibleName("Export");
  held.resolve();
  await savedLink("original", destination.links.original);
  expect(first).toBeEnabled();
  expect(first).toHaveAttribute("aria-busy", "false");
});
test("markdown-table-export-026 a linkless save remains repeatable and the next response supplies the link", async () => {
  const { destination } = spreadsheetBoundary();
  await table(forecast);
  await saveTo("original");
  const notice = (await screen.findByText("Saved to Google Drive")).closest(
    "li",
  );
  expect(notice).toBeVisible();
  expect(notice?.querySelector("a")).toBeNull();
  destination.links.original = "https://drive.example.org/second-receipt";
  await saveTo("original");
  await savedLink("original", destination.links.original);
});

test.each([
  [
    "markdown-table-export-023",
    "original",
    "Could not upload the table. Please try again.",
  ],
  [
    "markdown-table-export-024",
    "google",
    "Google Drive is temporarily unavailable",
  ],
] as const)(
  "%s retry reaches the requested destination after service recovery",
  async (_id, mode, message) => {
    const { destination } = spreadsheetBoundary();
    const telemetry = context.mocks.posthog();
    let storageHealthy = mode !== "original";
    context.mocks.http.put("https://mock-upload.r2.test/*", () => {
      return new HttpResponse(null, { status: storageHealthy ? 200 : 503 });
    });
    destination.unavailable = mode === "google";
    await table(forecast);
    await saveTo(mode);
    await screen.findByText(message);
    storageHealthy = true;
    destination.unavailable = false;
    destination.links[mode] = "https://exports.example.test/recovered";
    await saveTo(mode);
    await savedLink(mode, destination.links[mode]);
    const actions = telemetry.events.filter((event) => {
      return event.name === "artifact_action_clicked";
    });
    expect(
      actions.map((event) => {
        return event.properties;
      }),
    ).toStrictEqual(
      Array.from({ length: 2 }, () => {
        return expect.objectContaining({
          action: "google_drive_sync",
          surface: "inline_table",
          target: mode === "original" ? "file" : "spreadsheet",
        });
      }),
    );
  },
);

test("markdown-table-export-014 exporting in reverse order produces two independent literal worksheets", async () => {
  const boundary = context.mocks.browser.blobDownload(),
    telemetry = context.mocks.posthog();
  await table(
    "| 员工 | 编号 | 公式 |\n|---|---|---|\n| [林](https://example.org/lin) | 00071 | =A2+1 |\n\n| Plan | Price |\n|---|---|\n| Annual | 42 |",
  );
  await screen.findByText("Annual", { selector: "td" });
  const buttons = queryAllByRoleFast("button").filter((button) => {
    return button.getAttribute("aria-label") === "Export";
  });
  for (const index of [1, 0]) {
    click(buttons[index]);
    click(
      await screen.findByText("Export Excel", {
        selector: '[role="menuitem"]',
      }),
    );
  }
  expect(
    boundary.downloads.map((d) => {
      return d.filename;
    }),
  ).toStrictEqual(["Table.xlsx", "Table.xlsx"]);
  const sheets = [];
  for (const { blob } of boundary.downloads) {
    if (!blob) {
      throw new Error("Missing workbook");
    }
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(archive["xl/workbook.xml"]).toBeDefined();
    const sheet = new DOMParser().parseFromString(
      strFromU8(archive["xl/worksheets/sheet1.xml"]),
      "application/xml",
    );
    const cells = [...sheet.getElementsByTagName("c")];
    expect(
      cells.every((c) => {
        return c.getAttribute("t") === "inlineStr";
      }),
    ).toBeTruthy();
    sheets.push(
      cells.map((c) => {
        return c.textContent;
      }),
    );
  }
  expect(sheets).toStrictEqual([
    ["Plan", "Price", "Annual", "42"],
    ["员工", "编号", "公式", "林 (https://example.org/lin)", "00071", "=A2+1"],
  ]);
  expect(
    telemetry.events
      .filter((e) => {
        return e.name === "artifact_action_clicked";
      })
      .map((e) => {
        return e.properties;
      }),
  ).toStrictEqual(
    Array.from({ length: 2 }, () => {
      return expect.objectContaining({
        surface: "inline_table",
        artifact_type: "spreadsheet",
        action: "download",
      });
    }),
  );
});
test("markdown-table-export-017 a newly connected Drive account serves both destinations", async () => {
  const { access, account, destination } = spreadsheetBoundary();
  access.needsConnection = true;
  const popup = Object.assign(context.mocks.browser.authWindow(), {
    location: { href: "about:blank" },
  });
  const opened = context.mocks.browser.open(popup);
  const auth = "https://accounts.example.org/table-export";
  const attempt = crypto.randomUUID();
  const completions = mockOAuthCompletions(context);
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      expect(params.connectionId).toBe(account);
      return respond(
        200,
        connectorAccountFixture(
          { kind: "builtin", connectorSlug: "google-drive" },
          { id: account },
        ),
      );
    },
  );
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, { connector: googleDriveCatalogItem("not-connected") });
  });
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ params, body, respond }) => {
      expect(params.connectorSlug).toBe("google-drive");
      expect(body.account.intent).toBe("add");
      completions.set(attempt, account);
      return respond(200, { authorizationUrl: auth, oauthAttemptId: attempt });
    },
  );
  await table(forecast);
  destination.links.original = "https://drive.example.org/native-copy";
  await saveTo("original");
  click(await findAction("button", "Connect"));
  await waitFor(() => {
    return expect(popup.location.href).toBe(auth);
  });
  access.needsConnection = false;
  await savedLink("original", destination.links.original);
  destination.links.google = "https://sheets.example.org/converted";
  await saveTo("google");
  await savedLink("google", destination.links.google);

  expect(opened.calls).toHaveLength(1);
});

test("markdown-table-export-021 alternating destinations preserves each table's artifact identity", async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()],
    artifacts: string[] = [crypto.randomUUID(), crypto.randomUUID()];
  const account = crypto.randomUUID();
  let next = 0;
  const metadata = (id: string) => {
    return {
      id,
      filename: "Table.xlsx",
      contentType: workbookType,
      size: 290,
      url: "https://files.example.org/" + id,
    };
  };
  context.mocks.api(uploadsContract.preparePrivate, ({ respond }) => {
    const id = ids[next++];
    return respond(200, {
      ...metadata(id),
      uploadUrl: "https://storage.example.org/" + id,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put("https://storage.example.org/*", () => {
    return new HttpResponse(null, { status: 200 });
  });
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    return respond(200, metadata(body.id));
  });
  context.mocks.api(
    artifactReferencesContract.ownerArtifact,
    ({ params, respond }) => {
      const index = ids.findIndex((id) => {
        return params.reference === id.replaceAll("-", "") + ".xlsx";
      });
      if (index === -1) {
        throw new Error("Unknown spreadsheet");
      }
      return respond(200, { artifactId: artifacts[index] });
    },
  );
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    const ix = artifacts.indexOf(params.artifactId),
      file = metadata(ids[ix]);
    return respond(200, {
      ...fileArtifactDetail(
        artifactSummary(params.artifactId, "file", "Budget"),
        { ...file, fileId: file.id },
      ),
      googleDriveSync: { status: "not_synced" },
      googleDriveConnectionId: account,
    });
  });
  const link = (id: string, mode: SaveMode) => {
    return "https://drive.example.org/" + id + "/" + mode;
  };
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    ({ params, body, respond }) => {
      return respond(200, {
        id: params.artifactId,
        name: "Table.xlsx",
        mimeType: body.mode === "google" ? sheetsType : workbookType,
        webViewLink: link(params.artifactId, body.mode),
      });
    },
  );
  await table(forecast + "\n\n| Team | Delta |\n|---|---|\n| East | 47 |");
  await screen.findByText("East", { selector: "td" });
  const buttons = queryAllByRoleFast("button").filter((b) => {
    return b.getAttribute("aria-label") === "Export";
  });
  for (const [index, mode] of [
    [0, "original"],
    [1, "google"],
    [0, "google"],
    [1, "original"],
  ] as const) {
    await saveTo(mode, buttons[index]);
    await savedLink(mode, link(artifacts[index], mode));
  }
  click(buttons[0]);
  await expect(screen.findByRole("menu")).resolves.toBeVisible();
  expect(buttons[1]).toBeEnabled();
});

test("markdown-table-export-015 a ready Google destination serves each export with its selected account without opening authorization", async () => {
  const { account, destination } = spreadsheetBoundary();
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  const opened = context.mocks.browser.open();
  await table("| Region | Units |\n|---|---|\n| Port | 86 |");
  for (const mode of ["original", "google"] as const) {
    const receipt = "https://workspace.example.test/" + account + "/" + mode;
    destination.links[mode] = receipt;
    await saveTo(mode);
    await savedLink(mode, receipt);
  }

  expect(opened.calls).toStrictEqual([]);
});
