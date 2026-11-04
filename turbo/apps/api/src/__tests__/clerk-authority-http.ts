import { isClerkAPIResponseError } from "@clerk/backend/errors";
import { http, HttpResponse } from "msw";
import { array, object, string } from "zod";
import { server } from "../mocks/server";
import { settleIncludingAbort } from "../signals/utils";
import { getApiTestMocks } from "./mocks";

const sessionSchema = object({
  id: string(),
  userId: string(),
  status: string(),
});
const membershipsSchema = object({
  data: array(
    object({ publicUserData: object({ userId: string() }).nullish() }),
  ),
});

async function response(
  read: () => Promise<unknown>,
  body: (value: unknown) => Record<string, unknown>,
): Promise<Response> {
  const result = await settleIncludingAbort(read);
  if (result.ok) {
    return HttpResponse.json(body(result.value));
  }
  if (isClerkAPIResponseError(result.error)) {
    if (result.error.status === undefined) {
      return HttpResponse.error();
    }
    return HttpResponse.json(
      { errors: [] },
      {
        status: result.error.status,
        headers: result.error.retryAfter
          ? { "Retry-After": String(result.error.retryAfter) }
          : undefined,
      },
    );
  }
  throw result.error;
}

/** Keep existing Clerk identities at the HTTP boundary used by cancellable authority reads. */
export function installClerkAuthorityHttp(): void {
  const clerk = getApiTestMocks().clerk;
  server.use(
    http.get("https://api.clerk.com/v1/sessions/:sessionId", ({ params }) => {
      return response(
        () => {
          return clerk.sessions.getSession(params.sessionId);
        },
        (value) => {
          const session = sessionSchema.parse(value);
          return {
            id: session.id,
            user_id: session.userId,
            status: session.status,
          };
        },
      );
    }),
    http.get(
      "https://api.clerk.com/v1/organizations/:orgId/memberships",
      ({ params, request }) => {
        const query = new URL(request.url).searchParams;
        return response(
          () => {
            return clerk.organizations.getOrganizationMembershipList({
              organizationId: params.orgId,
              userId: query.getAll("user_id"),
              limit: Number(query.get("limit")),
            });
          },
          (value) => {
            return {
              data: membershipsSchema.parse(value).data.map((member) => {
                return {
                  public_user_data: member.publicUserData
                    ? { user_id: member.publicUserData.userId }
                    : member.publicUserData,
                };
              }),
            };
          },
        );
      },
    ),
  );
}
