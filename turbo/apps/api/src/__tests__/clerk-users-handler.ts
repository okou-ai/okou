import { HttpResponse, http } from "msw";
import { z } from "zod";
import { getApiTestMocks } from "./mocks";
import { settle } from "../signals/utils";

// Existing route fixtures describe SDK-shaped users. Serialize them at the HTTP
// boundary so those routes now exercise the production list transport as well.
const userFixture = z.object({
  id: z.string(),
  emailAddresses: z
    .array(z.object({ id: z.string(), emailAddress: z.string() }))
    .default([]),
  primaryEmailAddressId: z.string().nullable().default(null),
  firstName: z.string().nullable().default(null),
  lastName: z.string().nullable().default(null),
  username: z.string().nullable().default(null),
  imageUrl: z.string().nullable().default(null),
  privateMetadata: z.record(z.string(), z.unknown()).default({}),
});
const listFixture = z.object({ data: z.array(userFixture) });
const errorFixture = z.object({
  status: z.number().optional(),
  retryAfter: z.number().optional(),
});

export const clerkUsersHandler = http.get(
  "https://api.clerk.com/v1/users",
  async ({ request }) => {
    const query = new URL(request.url).searchParams;
    const userId = query.getAll("user_id");
    const emailAddress = query.getAll("email_address");
    const params = {
      ...(userId.length > 0 ? { userId } : {}),
      ...(emailAddress.length > 0 ? { emailAddress } : {}),
      ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}),
      ...(query.has("offset") ? { offset: Number(query.get("offset")) } : {}),
    };
    const result = await settle(
      getApiTestMocks().clerk.users.getUserList(params),
      request.signal,
    );
    if (!result.ok) {
      const parsed = errorFixture.safeParse(result.error);
      const status = parsed.success ? (parsed.data.status ?? 500) : 500;
      const retryAfter = parsed.success ? parsed.data.retryAfter : undefined;
      return HttpResponse.json(
        {
          errors: [{ code: "test_provider_failure", message: "Clerk failed" }],
        },
        {
          status,
          headers:
            retryAfter === undefined
              ? undefined
              : { "Retry-After": String(retryAfter) },
        },
      );
    }
    return HttpResponse.json(
      listFixture.parse(result.value).data.map((user) => {
        return {
          object: "user",
          id: user.id,
          email_addresses: user.emailAddresses.map((email) => {
            return { id: email.id, email_address: email.emailAddress };
          }),
          primary_email_address_id: user.primaryEmailAddressId,
          first_name: user.firstName,
          last_name: user.lastName,
          username: user.username,
          image_url: user.imageUrl ?? "",
          private_metadata: user.privateMetadata,
        };
      }),
    );
  },
);
