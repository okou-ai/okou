package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.auth.CanonicalWorkspaceSession
import ai.okou.android.auth.WorkspaceIdentity
import java.io.Closeable
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy

/** External canonical HTTP fixture, shared by actual native and host consumers. */
class InstructionsApiFixture : Closeable {
    val server = MockWebServer()
    val requests = ConcurrentLinkedQueue<RecordedRequest>()
    @Volatile var enabled = true
    @Volatile var denied = false
    @Volatile var disconnectSave = false
    @Volatile var beforeRead: () -> Unit = {}
    @Volatile var responseOwner: String? = null
    private val lock = Any()
    private var revision = 1
    @Volatile
    var saved =
        PersonalInstructions(
            "org-a",
            "user-a",
            "Original instructions",
            "2026-11-14T00:00:00Z",
            "v1",
        )
        private set

    val identity: WorkspaceIdentity
    val service: CanonicalWorkspaceSession

    fun externalEdit(content: String) =
        synchronized(lock) { saved = saved.copy(content = content, version = "v${++revision}") }

    private fun body() =
        synchronized(lock) {
            Json.encodeToString(saved.copy(userId = responseOwner ?: saved.userId))
        }

    init {
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests.add(request)
                    if (request.path == "/api/feature-switches")
                        return json(
                            """{"switches":{},"effectiveSwitches":{"singleAgent":$enabled}}"""
                        )
                    if (request.path != "/api/instructions")
                        return MockResponse().setResponseCode(404)
                    if (request.method == "GET") beforeRead()
                    if (!enabled || denied)
                        return json("""{"error":{"code":"FORBIDDEN","message":"Unavailable"}}""")
                            .setResponseCode(403)
                    if (request.method == "PUT")
                        synchronized(lock) {
                            val input =
                                Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                            if (input["ifVersion"]?.jsonPrimitive?.content != saved.version)
                                return json("""{"error":{"code":"CONFLICT","message":"Changed"}}""")
                                    .setResponseCode(409)
                            val content = input.getValue("content").jsonPrimitive.content
                            if (content.contains('\u0000'))
                                return MockResponse().setResponseCode(400)
                            externalEdit(content)
                        }
                    return json(body()).also {
                        if (request.method == "PUT" && disconnectSave)
                            it.setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    }
                }
            }
        server.start()
        identity = WorkspaceIdentity(server.url("/").toString(), "user-a", "session-a", "org-a")
        service = CanonicalWorkspaceSession(identity, WorkspaceTokenProvider { "fixture-token" })
    }

    private fun json(body: String) =
        MockResponse().setHeader("Content-Type", "application/json").setBody(body)

    override fun close() {
        service.close()
        server.close()
    }
}
