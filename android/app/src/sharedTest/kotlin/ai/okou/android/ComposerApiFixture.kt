package ai.okou.android

import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy

/** Isolated external HTTP content; installed session, transport and native consumers are real. */
class ComposerApiFixture : Closeable {
    val chats = ChatListApiFixture()
    val service
        get() = chats.service

    val identity
        get() = chats.identity

    val requests = CopyOnWriteArrayList<RecordedRequest>()
    val inputs = ConcurrentHashMap<String, JsonObject>()
    private val inputOrder = CopyOnWriteArrayList<String>()
    val created = CopyOnWriteArrayList<JsonObject>()
    @Volatile var disconnectSend = false
    @Volatile var beforeSendReturn: () -> Unit = {}
    @Volatile var beforeContextReturn: () -> Unit = {}
    @Volatile var inputDisposition = "queued"

    init {
        chats.flags = {
            json("""{"switches":{},"effectiveSwitches":{"projects":true,"singleAgent":true}}""")
        }
        chats.commandResponse = { request ->
            val path = request.requestUrl?.encodedPath.orEmpty()
            when {
                path == "/api/onboarding/status" -> {
                    requests += request
                    beforeContextReturn()
                    json(
                        """{"needsOnboarding":false,"onboardingComplete":true,"isAdmin":false,"hasOrg":true,"hasDefaultAgent":true,"defaultAgentId":"$CHAT_AGENT","defaultAgentMetadata":null}"""
                    )
                }
                path == "/api/chat-threads" && request.method == "POST" -> {
                    requests += request
                    val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                    val id = body.getValue("clientThreadId").jsonPrimitive.content
                    if (created.none { it.getValue("clientThreadId").jsonPrimitive.content == id })
                        created += body
                    json(
                            buildJsonObject {
                                    put("id", JsonPrimitive(id))
                                    put("projectId", body["projectId"] ?: JsonNull)
                                    put("title", JsonNull)
                                    put("createdAt", JsonPrimitive(CHAT_DATE))
                                    put("selectedModel", JsonNull)
                                    put("serviceTier", JsonNull)
                                }
                                .toString()
                        )
                        .setResponseCode(201)
                }
                path == "/api/chat/events" && request.method == "POST" -> {
                    requests += request
                    val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                    val event = body.getValue("clientEventId").jsonPrimitive.content
                    val prior = inputs.putIfAbsent(event, body)
                    if (prior == null) inputOrder += event
                    if (prior != null && prior != body)
                        json("""{"error":{"code":"CONFLICT","message":"Input identity changed"}}""")
                            .setResponseCode(409)
                    else {
                        beforeSendReturn()
                        json(
                                """{"threadId":${body.getValue("threadId")},"createdAt":"$CHAT_DATE"}"""
                            )
                            .setResponseCode(201)
                            .also {
                                if (disconnectSend)
                                    it.setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                            }
                    }
                }
                path.contains("/inputs/") && path.endsWith("/status") -> {
                    requests += request
                    val parts = checkNotNull(request.requestUrl).pathSegments
                    val input = inputs[parts[4]]
                    val status =
                        if (input?.get("threadId")?.jsonPrimitive?.content == parts[2])
                            inputDisposition
                        else "unavailable"
                    val coordinate =
                        if (status == "unavailable") "null"
                        else
                            "{\"eventId\":\"${parts[4]}\",\"seqId\":40,\"createdAt\":\"$CHAT_DATE\"}"
                    val replaced = status !in setOf("queued", "unavailable")
                    val replacement =
                        if (replaced)
                            "{\"eventId\":\"$HISTORY_LAST_EVENT\",\"seqId\":41,\"createdAt\":\"$CHAT_DATE\"}"
                        else "null"
                    val consumed = status in setOf("consumed", "completed", "failed", "cancelled")
                    val terminal =
                        if (status in setOf("completed", "failed", "cancelled"))
                            "{\"eventId\":\"$CHAT_EVENT\",\"seqId\":42,\"createdAt\":\"$CHAT_DATE\"}"
                        else "null"
                    json(
                        """{"threadId":"${parts[2]}","eventId":"${parts[4]}","input":$coordinate,"replacement":$replacement,"status":"$status","runId":${if (consumed) "\"$HISTORY_RUN\"" else "null"},"terminal":$terminal}"""
                    )
                }
                created.any {
                    path.startsWith(
                        "/api/chat-threads/" + it.getValue("clientThreadId").jsonPrimitive.content
                    )
                } ->
                    when {
                        path.endsWith("/event-snapshot") ->
                            json(
                                    """{"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"Not archived"}}"""
                                )
                                .setResponseCode(404)
                        path.endsWith("/event-rows") -> rows(request)
                        path.endsWith("/mark-read") -> json("""{"lastReadAt":"$CHAT_DATE"}""")
                        else -> json("""{"lastReadAt":null,"cancellationRecoveryPending":false}""")
                    }
                else -> null
            }
        }
        chats.events = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0
            val rows = mutableListOf<JsonObject>()
            if (since < 17) rows += Json.parseToJsonElement(chatEventWire()).jsonObject
            if (since < 23)
                rows +=
                    Json.parseToJsonElement(
                            chatEventWire(
                                id = "77777777-7777-4777-8777-777777777777",
                                seq = 23,
                                thread = CHAT_IN_PROJECT,
                                extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                                title = "Project chat",
                                agent = CHAT_OTHER_AGENT,
                            )
                        )
                        .jsonObject
            created.forEachIndexed { index, body ->
                val seq = 30L + index
                if (seq > since)
                    rows +=
                        Json.parseToJsonElement(
                                chatEventWire(
                                    id = body.getValue("eventId").jsonPrimitive.content,
                                    seq = seq,
                                    thread = body.getValue("clientThreadId").jsonPrimitive.content,
                                    agent = body.getValue("agentId").jsonPrimitive.content,
                                    title = "New conversation",
                                    extra =
                                        body["projectId"]?.let { ",\"projectId\":$it" }.orEmpty(),
                                )
                            )
                            .jsonObject
            }
            json("""{"events":${JsonArray(rows)},"hasMore":false}""")
        }
        chats.historyRows = ::rows
    }

    private fun rows(request: RecordedRequest): MockResponse {
        val url = checkNotNull(request.requestUrl)
        val thread = url.pathSegments[2]
        val since = checkNotNull(url.queryParameter("sinceSeqId")).toLong()
        val rows =
            inputOrder
                .mapNotNull(inputs::get)
                .filter { it["threadId"]?.jsonPrimitive?.content == thread }
                .mapIndexed { index, body ->
                    Json.parseToJsonElement(
                            historyEventWire(
                                id = body.getValue("clientEventId").jsonPrimitive.content,
                                seq = 40L + index,
                                thread = thread,
                                type = "input.prompt",
                                payload = "{\"userMessage\":${body.getValue("userMessage")}}",
                                run = null,
                            )
                        )
                        .jsonObject
                }
                .filter { it.getValue("seqId").jsonPrimitive.content.toLong() > since }
        val cursor =
            rows.lastOrNull()?.let {
                "{\"lastEventId\":${it.getValue("id")},\"lastSeqId\":${it.getValue("seqId")}}"
            }
                ?: "{\"lastEventId\":${url.queryParameter("sinceEventId")?.let { "\"$it\"" } ?: "null"},\"lastSeqId\":$since}"
        return json("""{"rows":${JsonArray(rows)},"cursor":$cursor,"hasMore":false}""")
    }

    private fun json(body: String) =
        MockResponse().setHeader("Content-Type", "application/json").setBody(body)

    override fun close() = chats.close()
}
