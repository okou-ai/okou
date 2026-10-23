import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";

/** Provider-owned memberships shared by the test's connected user and bot. */
export function mockSharedSlackConversations(
  channels: readonly string[] = [
    "C_GRAPH_0",
    "C_GRAPH_1",
    "C_GRAPH_2",
    "C_GRAPH_3",
    "C_GRAPH_4",
    "C123",
    "C123456",
    "C-invalid",
    "C_GRAPH",
    "D-mock-dm",
    "D-SELF",
  ],
  dmRecipientId = "U_DM_RECIPIENT",
) {
  server.use(
    http.get("https://slack.com/api/conversations.info", ({ request }) => {
      return HttpResponse.json({
        ok: true,
        channel: {
          id: new URL(request.url).searchParams.get("channel"),
          is_archived: false,
          is_read_only: false,
          ...(new URL(request.url).searchParams.get("channel")?.startsWith("D")
            ? { is_im: true, is_mpim: false, user: dmRecipientId }
            : {}),
        },
      });
    }),
    http.get("https://slack.com/api/users.info", ({ request }) => {
      return HttpResponse.json({
        ok: true,
        user: {
          id: new URL(request.url).searchParams.get("user"),
          is_admin: false,
          is_owner: false,
          deleted: false,
        },
      });
    }),
    http.get("https://slack.com/api/users.conversations", () => {
      return HttpResponse.json({
        ok: true,
        channels: channels.map((id) => {
          return { id };
        }),
        response_metadata: { next_cursor: "" },
      });
    }),
  );
}
