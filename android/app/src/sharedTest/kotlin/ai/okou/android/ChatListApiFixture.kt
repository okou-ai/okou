package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.auth.CanonicalWorkspaceSession
import ai.okou.android.auth.WorkspaceIdentity
import java.io.Closeable
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

const val CHAT_AGENT = "22222222-2222-4222-8222-222222222222"
const val CHAT_OTHER_AGENT = "33333333-3333-4333-8333-333333333333"
const val CHAT_PROJECT = "44444444-4444-4444-8444-444444444444"
const val CHAT_PERSONAL = "11111111-1111-4111-8111-111111111111"
const val CHAT_IN_PROJECT = "55555555-5555-4555-8555-555555555555"
const val CHAT_EVENT = "66666666-6666-4666-8666-666666666666"
const val CHAT_DATE = "2026-11-13T00:00:00.000Z"

fun chatEventWire(
    id: String = CHAT_EVENT,
    seq: Long = 17,
    thread: String = CHAT_PERSONAL,
    kind: String = "created",
    extra: String = "",
    title: String = "Personal chat",
    agent: String = CHAT_AGENT,
): String =
    """{"id":"$id","seqId":$seq,"kind":"$kind","chatThreadId":"$thread","agentId":"$agent","title":"$title","selectedModel":null,"serviceTier":null,"computerUseHostId":null,"createdAt":"$CHAT_DATE"$extra}"""

/** Only the external HTTP boundary is substituted; native owners/codec/cache/transport are real. */
class ChatListApiFixture : Closeable {
    val server = MockWebServer()
    @Volatile var beforeResponse: () -> Unit = {}
    @Volatile
    var flags: () -> MockResponse = {
        jsonResponse("""{"switches":{},"effectiveSwitches":{"projects":true}}""")
    }
    @Volatile
    var snapshot: () -> MockResponse = {
        jsonResponse("""{"chatThreads":[],"latestEventId":null,"latestSeqId":null}""")
    }
    @Volatile
    var events: (RecordedRequest) -> MockResponse = { request ->
        if (request.requestUrl?.queryParameter("sinceSeqId") != null)
            jsonResponse("""{"events":[],"hasMore":false}""")
        else
            jsonResponse(
                """{"events":[${chatEventWire()},${chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23, thread = CHAT_IN_PROJECT, extra = ",\"projectId\":\"$CHAT_PROJECT\"", title = "Project chat", agent = CHAT_OTHER_AGENT)}],"hasMore":false}"""
            )
    }
    @Volatile
    var indicators: () -> MockResponse = {
        jsonResponse(
            """{"agents":{},"threads":{"$CHAT_PERSONAL":"active","$CHAT_IN_PROJECT":"unread"},"unreadAt":{"$CHAT_IN_PROJECT":"$CHAT_DATE"}}"""
        )
    }
    @Volatile
    var agents: () -> MockResponse = {
        jsonResponse(
            """[{"agentId":"$CHAT_AGENT","isDefaultAgent":true,"ownerId":"user-a","description":null,"displayName":"My Okou","sound":null,"avatarUrl":null,"visibility":"private"},{"agentId":"$CHAT_OTHER_AGENT","isDefaultAgent":false,"ownerId":"user-a","description":null,"displayName":"Research Okou","sound":null,"avatarUrl":null,"visibility":"private"}]"""
        )
    }
    @Volatile
    var projects: () -> MockResponse = {
        jsonResponse(
            """{"projects":[{"id":"$CHAT_PROJECT","name":"Research","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}]}"""
        )
    }
    @Volatile var archive: () -> MockResponse = { jsonResponse("""{"chatThreads":[]}""") }
    val identity: WorkspaceIdentity
    val service: CanonicalWorkspaceSession

    init {
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    beforeResponse()
                    return when (request.requestUrl?.encodedPath) {
                        "/api/feature-switches" -> flags()
                        "/api/chat-threads/snapshot" -> snapshot()
                        "/api/chat-threads/events" -> events(request)
                        "/api/indicators" -> indicators()
                        "/api/agents" -> agents()
                        "/api/projects" -> projects()
                        "/archive" -> archive()
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
        server.start()
        identity =
            WorkspaceIdentity(server.url("/").toString(), "user-a", "session-a", "org-a", "member")
        service = CanonicalWorkspaceSession(identity, WorkspaceTokenProvider { "fixture-token" })
    }

    override fun close() {
        service.close()
        server.close()
    }
}

fun jsonResponse(body: String) =
    MockResponse().setHeader("Content-Type", "application/json").setBody(body)
