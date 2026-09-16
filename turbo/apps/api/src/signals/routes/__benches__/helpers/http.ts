import { HttpResponse, delay, http } from "msw";

export const MOCK_R2_LIST_DELAY_MS = 10;

// Keep benchmark dependencies local without bypassing the shared MSW handlers
// or its error policy for unexpected requests.
export function createBenchHttpHandlers() {
  return [
    http.get(
      /^https:\/\/[^/]+\.r2\.cloudflarestorage\.com\//,
      async ({ request }) => {
        const url = new URL(request.url);
        const pathBucket = url.pathname.split("/").filter(Boolean)[0];
        const hostBucket = url.hostname.split(".")[0];
        const bucket = pathBucket ?? hostBucket;
        if (
          bucket !== "test-user-artifacts" ||
          url.searchParams.get("list-type") !== "2"
        ) {
          return HttpResponse.text("not found", { status: 404 });
        }

        await delay(MOCK_R2_LIST_DELAY_MS);
        const prefix = url.searchParams.get("prefix") ?? "";
        return HttpResponse.xml(
          `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>test-user-artifacts</Name>
  <Prefix>${prefix}</Prefix>
  <KeyCount>1</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>${prefix}bench-attachment.md</Key>
    <LastModified>2026-05-25T00:00:00.000Z</LastModified>
    <ETag>"bench-etag"</ETag>
    <Size>4096</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>`,
        );
      },
    ),
    http.get("https://api.anthropic.com/api/oauth/profile", () => {
      return HttpResponse.json({
        account: { uuid: "bench-claude-account", email: "bench@example.test" },
        organization: {
          uuid: "bench-claude-org",
          name: "Bench API",
          organization_type: "claude_pro",
        },
      });
    }),
    http.get("https://api.anthropic.com/api/oauth/usage", () => {
      return HttpResponse.json({
        five_hour: { utilization: 25, resets_at: "2099-01-01T05:00:00.000Z" },
        seven_day: { utilization: 10, resets_at: "2099-01-08T00:00:00.000Z" },
      });
    }),
  ];
}
