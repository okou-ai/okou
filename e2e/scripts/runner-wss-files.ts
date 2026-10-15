import assert from "node:assert/strict";
import type { RunnerWssClient } from "./runner-wss-client";

const token = (name: string) => Buffer.from(name).toString("base64url");
const homePath = [token("home"), token("user")];

/** Real owned home fixtures, through the existing admitted channel. */
export async function probeHomeFiles(client: RunnerWssClient, fixture: string) {
  let cursor: string | null = null;
  try {
    for (const [path, name] of [
      [[], "home"],
      [[token("home")], "user"],
    ] as const) {
      const page = await client.list({ path });
      assert.ok(
        page.entries.some(
          (entry) =>
            entry.nameToken === token(name) && entry.kind === "directory",
        ),
        "Actual root and home ancestors must be browsable",
      );
      if (page.nextCursor) await client.closeCursor(page.nextCursor);
    }
    let home = await client.list({ path: homePath });
    const homeListing = home.listingId;
    let found = false;
    for (let pages = 0; pages < 32; pages += 1) {
      assert.equal(home.listingId, homeListing);
      cursor = home.nextCursor;
      found = home.entries.some(
        (entry) =>
          entry.nameToken === token(fixture) && entry.kind === "directory",
      );
      if (found || !cursor) break;
      home = await client.list({ cursor });
    }
    assert.ok(found, "Owned fixture must be visible from actual home");
    if (cursor) await client.closeCursor(cursor);
    cursor = null;

    let page = await client.list({ path: [...homePath, token(fixture)] });
    const listing = page.listingId;
    const names = new Set<string>();
    let pages = 0;
    for (;;) {
      assert.equal(
        page.listingId,
        listing,
        "Continuation must keep listing identity",
      );
      cursor = page.nextCursor;
      for (const entry of page.entries) {
        assert.ok(
          !names.has(entry.nameToken),
          "Directory pages must not repeat entries",
        );
        names.add(entry.nameToken);
      }
      pages += 1;
      if (!cursor) break;
      assert.ok(
        pages < 8,
        "Owned listing must complete within its fixture bound",
      );
      page = await client.list({ cursor });
    }
    assert.equal(names.size, 273, "Every owned entry must survive pagination");
    assert.ok(pages >= 3 && names.has(token(".hidden")));
    const nested = await client.list({
      path: [...homePath, token(fixture), token("nested")],
    });
    assert.equal(nested.nextCursor, null);
    assert.equal(nested.entries.length, 1);
    assert.equal(nested.entries[0]?.nameToken, token("leaf"));
    await client.rejectFs(
      "list",
      { path: [...homePath, token(fixture), token("outside")] },
      "link_not_expandable",
    );
    await client.rejectFs("unknown", { path: [] }, "unknown_operation");
    await client.rejectFs("list", { path: [token("..")] }, "invalid_params");

    const abandoned = await client.list({
      path: [...homePath, token(fixture)],
    });
    cursor = abandoned.nextCursor;
    assert.ok(cursor, "Paging must expose an owned continuation");
    const closed = cursor;
    await client.closeCursor(closed);
    cursor = null;
    await client.rejectFs("list", { cursor: closed }, "cursor_expired");
    client.assertHealthy();
    return {
      filesystemVersion: 2,
      actualRoot: true,
      actualHomeAncestor: true,
      actualHome: true,
      directoryPages: pages,
      nestedDirectory: true,
      containmentRejection: true,
      cursorRelease: true,
    };
  } finally {
    if (cursor) await client.closeCursor(cursor);
  }
}
