import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";

import { mockApi } from "../msw-contract.ts";

/**
 * Restored composer attachments resolve their artifact id against this route,
 * so every test that opens a saved draft would otherwise need its own handler.
 * The default says "still resolves"; tests covering an unreadable artifact
 * override it with a 404.
 */
export const apiWebFilesHandlers = [
  mockApi(webFilesContract.fileUrl, ({ query, respond }) => {
    return respond(200, {
      downloadUrl: new URL(
        "?download=1",
        `https://cdn.vm0.io/artifacts/${query.file_id}`,
      ).href,
      url: `https://cdn.vm0.io/artifacts/${query.file_id}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: `https://cdn.vm0.io/artifacts/${query.file_id}`,
    });
  }),
];
