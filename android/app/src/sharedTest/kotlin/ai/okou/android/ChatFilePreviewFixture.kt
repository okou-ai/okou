package ai.okou.android

import java.util.concurrent.CopyOnWriteArrayList
import okhttp3.mockwebserver.MockResponse

internal class ChatFilePreviewFixture(private val api: ChatListApiFixture) {
    val filename = "launch-checklist.txt"
    val prompt = "Here is the launch checklist."
    val preview = "Confirm the launch owner and review the release notes."
    val original = "Confirm the launch owner and review the release notes.\r\n"
    val requests = CopyOnWriteArrayList<String>()
    @Volatile var denied = false

    fun install() {
        val fileId = "51446000-0000-4000-8000-000000000001"
        api.setHistoryEvents(
            CHAT_PERSONAL,
            listOf(
                historyEventWire(
                    id = "51446000-0000-4000-8000-000000000002",
                    seq = 1,
                    type = "input.prompt",
                    payload =
                        """
                        {"userMessage":{"version":1,"parts":[
                          {"type":"text","text":"$prompt"},
                          {"type":"file","fileId":"$fileId","filenameSnapshot":"$filename","contentType":"text/plain"}
                        ]}}
                        """
                            .trimIndent(),
                ),
                historyEventWire(
                    id = "51446000-0000-4000-8000-000000000003",
                    seq = 2,
                    type = "run.completed",
                    payload = "null",
                ),
            ),
        )
        val previous = api.commandResponse
        val previewUrl = api.server.url("/chat-file/preview")
        val originalUrl = api.server.url("/chat-file/download")
        api.commandResponse = { request ->
            val path = request.requestUrl?.encodedPath
            if (path == "/api/web/file-url" || path?.startsWith("/chat-file/") == true) {
                requests += checkNotNull(path)
            }
            when (path) {
                "/api/web/file-url" ->
                    if (denied || request.requestUrl?.queryParameter("file_id") != fileId) {
                        MockResponse().setResponseCode(404)
                    } else {
                        jsonResponse(
                            """{"url":"$previewUrl","downloadUrl":"$originalUrl","expiresAt":"2099-01-01T00:00:00Z","publicUrl":null}""",
                        )
                    }
                "/chat-file/preview" -> MockResponse().setBody(preview)
                "/chat-file/download" -> MockResponse().setBody(original)
                else -> previous(request)
            }
        }
    }
}
