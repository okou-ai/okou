import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { sendCommand } from "../../send";

const server = setupServer(
  http.post(
    "http://localhost:3000/api/integrations/discord/message",
    async ({ request }) => {
      const body: unknown = await request.json();
      console.log(JSON.stringify(body));
      return HttpResponse.json({
        messages: [
          {
            id: "1346579924358245001",
            channelId: "1346579924358245999",
            url: "https://discord.com/channels/1346579924358245889/1346579924358245999/1346579924358245001",
          },
        ],
      });
    },
  ),
);
server.listen({ onUnhandledRequest: "error" });
try {
  await sendCommand.parseAsync(process.argv);
} finally {
  server.close();
}
