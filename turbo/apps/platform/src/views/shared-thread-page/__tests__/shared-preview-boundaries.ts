import {
  sharedThreadsContract,
  type SharedMessage,
} from "@okouai/api-contracts/contracts/shared-threads";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  sharedThread,
  SHARED_THREAD_ID,
} from "./shared-thread-test-helpers.ts";

const host = "app.okou.ai";
export function sharedFile(name: string, contentType: string, fragment = "") {
  const path = "https://" + host + "/artifacts/" + name;
  const url = "https://cdn.okou.io/artifacts/briefing/media/" + name;
  return {
    id: crypto.randomUUID(),
    name,
    contentType,
    original: path + fragment,
    url,
    fragment,
    download: url + "?save=1",
    cover: "https://images.example.test/" + name + ".png",
  };
}
type Resource = ReturnType<typeof sharedFile>;
export async function publicConversation(
  context: TestContext,
  files: readonly Resource[],
  messages: readonly SharedMessage[],
  signedIn = false,
) {
  const grants = new Map(
    files.map((f) => {
      return [f.name, f];
    }),
  );
  const unauthenticated: string[] = [];
  context.mocks.api(sharedThreadsContract.get, ({ params, respond }) => {
    return params.id === SHARED_THREAD_ID
      ? respond(200, sharedThread({ messages }))
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown conversation" },
        });
  });
  context.mocks.api(
    artifactReferencesContract.publicUrl,
    ({ params, request, respond }) => {
      const f = grants.get(params.reference);
      if (!f) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Link revoked" },
        });
      }
      if (!request.headers.has("authorization")) {
        unauthenticated.push(f.name);
      }
      return respond(200, {
        url: f.url,
        downloadUrl: f.download,
        preview: {
          filename: f.name,
          contentType: f.contentType,
          previewImageUrl: f.cover,
        },
      });
    },
  );
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, request, respond }) => {
      const f = grants.get(params.reference);
      if (!f) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Link revoked" },
        });
      }
      if (signedIn && !request.headers.has("authorization")) {
        return respond(401, {
          error: {
            code: "UNAUTHORIZED",
            message: "The member grant requires authentication",
          },
        });
      }
      if (!request.headers.has("authorization")) {
        unauthenticated.push("view:" + f.name);
      }
      return respond(200, {
        url: f.url,
        downloadUrl: f.download,
        downloadAllowed: true,
        expiresAt: "2099-01-01T00:00:00Z",
        filename: f.name,
        contentType: f.contentType,
        target: {
          kind: f.contentType === "text/html" ? "html" : "file",
          id: f.id,
        },
        previewImageUrl: f.cover,
      });
    },
  );
  await setupPage({
    context,
    host,
    path: "/share/threads/" + SHARED_THREAD_ID,
    ...(signedIn ? {} : { auth: null }),
  });
  return { grants, unauthenticated };
}
export function promptFiles(files: readonly Resource[]): SharedMessage {
  return {
    messageIndex: 0,
    role: "user",
    content: "Review these attachments",
    attachments: files.map((f) => {
      return {
        filename: f.name,
        contentType: f.contentType,
        url: f.original,
        size: 920,
      };
    }),
  };
}
export function sharedBody(content: string): SharedMessage {
  return { messageIndex: 0, role: "assistant", content };
}
