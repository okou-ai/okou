package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.auth.CanonicalWorkspaceSession
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chat.plainDraftDocument
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals

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
): String {
    return """{"id":"$id","seqId":$seq,"kind":"$kind","chatThreadId":"$thread","title":"$title","selectedModel":null,"serviceTier":null,"computerUseHostId":null,"createdAt":"$CHAT_DATE"$extra}"""
}

internal fun ChatListApiFixture.rowEventTail(
    beforeReadback: (Long) -> Unit = {}
): MutableList<Pair<Long, String>> {
    val initialEvents = events
    val tail = CopyOnWriteArrayList<Pair<Long, String>>()
    events = { request ->
        val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong()
        if (since == null) initialEvents(request)
        else {
            if (tail.isNotEmpty()) beforeReadback(since)
            val observed = tail.filter { it.first > since }.joinToString(",") { it.second }
            jsonResponse("""{"events":[$observed],"hasMore":false}""")
        }
    }
    return tail
}

internal fun RecordedRequest.rowEvent(
    seq: Long,
    thread: String,
    kind: String,
    extra: String = "",
): String {
    val id = checkNotNull(requestUrl?.queryParameter("eventId"))
    assertEquals(id, UUID.fromString(id).toString())
    assertEquals("Bearer fixture-token", getHeader("Authorization"))
    assertEquals(0L, bodySize)
    return chatEventWire(id = id, seq = seq, thread = thread, kind = kind, extra = extra)
}

const val HISTORY_LAST_EVENT = "88888888-8888-4888-8888-888888888888"
const val HISTORY_RUN = "99999999-9999-4999-8999-999999999999"

fun historyEventWire(
    id: String = HISTORY_LAST_EVENT,
    seq: Long = 37,
    thread: String = CHAT_PERSONAL,
    type: String = "output.message",
    payload: String = "{\"content\":\"**Native history** reply\"}",
    run: String? = HISTORY_RUN,
    revoke: String? = null,
): String =
    """{"id":"$id","chatThreadId":"$thread","runId":${run?.let { "\"$it\"" } ?: "null"},"revokesEventId":${revoke?.let { "\"$it\"" } ?: "null"},"contextType":"web","contextId":null,"runEventSequenceNumber":null,"runEventId":null,"seqId":$seq,"createdAt":"$CHAT_DATE","eventType":"$type","payload":$payload}"""

/** Only the external HTTP boundary is substituted; native owners/codec/cache/transport are real. */
class ChatListApiFixture : Closeable {
    private val transport = FixtureHttpsServer()
    val server = transport.server
    @Volatile var beforeResponse: () -> Unit = {}
    @Volatile var commandResponse: (RecordedRequest) -> MockResponse? = { null }
    @Volatile var beforeHistoryResponse: (RecordedRequest) -> Unit = {}
    @Volatile var historyThreadIds = setOf(CHAT_PERSONAL, CHAT_IN_PROJECT)

    private fun defaultHistory(thread: String, after: Long): List<String> =
        listOf(
                historyEventWire(
                    "input",
                    17,
                    thread,
                    "input.prompt",
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Hello history"}]}}""",
                ),
                historyEventWire("output", 23, thread),
                historyEventWire(HISTORY_LAST_EVENT, 37, thread, "run.completed", "null"),
            )
            .filter {
                Json.parseToJsonElement(it).jsonObject.getValue("seqId").jsonPrimitive.long > after
            }

    @Volatile
    var historyCatchUp: (RecordedRequest) -> MockResponse = { request ->
        val events =
            Json.parseToJsonElement(request.body.clone().readUtf8()).jsonArray.associate { tuple ->
                val items = tuple.jsonArray
                val id = items[0].jsonPrimitive.content
                id to
                    JsonArray(
                        defaultHistory(id, items[1].jsonPrimitive.long).map {
                            Json.parseToJsonElement(it)
                        }
                    )
            }
        jsonResponse(
            JsonObject(
                    mapOf(
                        "events" to JsonObject(events),
                        "notFoundThreads" to JsonArray(emptyList()),
                    )
                )
                .toString()
        )
    }
    val readRequests = java.util.concurrent.atomic.AtomicInteger()
    @Volatile
    var historyMarkRead: () -> MockResponse = { jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""") }
    @Volatile
    var historyDetail: () -> MockResponse = {
        jsonResponse("""{"lastReadAt":null,"cancellationRecoveryPending":false}""")
    }
    @Volatile
    var historySnapshot: () -> MockResponse = {
        jsonResponse(
                """{"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"Not archived"}}"""
            )
            .setResponseCode(404)
    }
    @Volatile var historyArchive: () -> MockResponse = { MockResponse().setBody("") }
    @Volatile
    var historyRows: (RecordedRequest) -> MockResponse = { request ->
        val thread = checkNotNull(request.requestUrl).pathSegments[2]
        val rows =
            defaultHistory(thread, request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0)
        jsonResponse(
            """{"rows":[${rows.joinToString(",")}],"cursor":{"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":37},"hasMore":false}"""
        )
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
                """{"events":[${chatEventWire()},${chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23, thread = CHAT_IN_PROJECT, extra = ",\"projectId\":\"$CHAT_PROJECT\"", title = "Project chat")}],"hasMore":false}"""
            )
    }
    @Volatile
    var indicators: () -> MockResponse = {
        jsonResponse(
            """{"threads":{"$CHAT_PERSONAL":"active","$CHAT_IN_PROJECT":"unread"},"unreadAt":{"$CHAT_IN_PROJECT":"$CHAT_DATE"}}"""
        )
    }
    @Volatile
    var projects: () -> MockResponse = {
        jsonResponse(
            """{"projects":[{"id":"$CHAT_PROJECT","name":"Research","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}"""
        )
    }
    @Volatile var archive: () -> MockResponse = { jsonResponse("""{"chatThreads":[]}""") }
    @Volatile
    var projectEvents: (RecordedRequest) -> MockResponse = {
        jsonResponse("""{"events":[],"hasMore":false}""")
    }
    val identity: WorkspaceIdentity
    val service: CanonicalWorkspaceSession
    private val composerDrafts = ConcurrentHashMap<String, JsonObject>()

    init {
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    beforeResponse()
                    commandResponse(request)?.let {
                        return it
                    }
                    val segments = request.requestUrl?.pathSegments.orEmpty()
                    if (
                        segments.size in 3..4 &&
                            segments[0] == "api" &&
                            (segments[1] == "chat-threads" ||
                                segments == listOf("api", "chat-drafts", "composer"))
                    ) {
                        val draftPath =
                            segments[1] == "chat-drafts" ||
                                segments.size == 4 && segments[3] == "draft"
                        val key = "${segments[1]}:${segments[2]}"
                        if (request.method == "GET" && draftPath)
                            return jsonResponse(
                                (composerDrafts[key] ?: plainDraftDocument("")).toString()
                            )
                        if (
                            request.method == "PATCH" &&
                                (segments[1] == "chat-drafts" ||
                                    segments[1] == "chat-threads" && segments.size == 3)
                        ) {
                            composerDrafts[key] =
                                Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                            return MockResponse().setResponseCode(204)
                        }
                    }
                    if (
                        segments.size >= 3 &&
                            segments[0] == "api" &&
                            segments[1] == "chat-threads" &&
                            segments[2] in historyThreadIds
                    ) {
                        beforeHistoryResponse(request)
                        return when (segments.getOrNull(3)) {
                            "event-snapshot" -> historySnapshot()
                            "event-rows" -> historyRows(request)
                            "mark-read" -> {
                                readRequests.incrementAndGet()
                                historyMarkRead()
                            }
                            null -> historyDetail()
                            else -> MockResponse().setResponseCode(404)
                        }
                    }
                    return when (request.requestUrl?.encodedPath) {
                        "/api/chat/events/catch-up" -> historyCatchUp(request)
                        "/api/chat-threads/snapshot" -> snapshot()
                        "/api/chat-threads/events" -> events(request)
                        "/api/indicators" -> indicators()
                        "/api/projects/snapshot" -> projects()
                        "/api/projects/events" -> projectEvents(request)
                        "/archive" -> archive()
                        "/history-archive" -> historyArchive()
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
        try {
            server.start()
            identity =
                WorkspaceIdentity(
                    server.url("/").toString(),
                    "user-a",
                    "session-a",
                    "org-a",
                    "member",
                )
            service =
                CanonicalWorkspaceSession(identity, WorkspaceTokenProvider { "fixture-token" })
        } catch (error: Throwable) {
            try {
                transport.close()
            } catch (cleanup: Throwable) {
                error.addSuppressed(cleanup)
            }
            throw error
        }
    }

    override fun close() {
        transport.use { service.close() }
    }
}

fun jsonResponse(body: String) =
    MockResponse().setHeader("Content-Type", "application/json").setBody(body)
