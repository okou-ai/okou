package ai.okou.android.api

import ai.okou.android.api.fixtures.Agents
import ai.okou.android.api.fixtures.CanonicalApi as FixtureApi
import ai.okou.android.api.fixtures.CanonicalEmptyArray
import ai.okou.android.api.fixtures.ChatArchive
import ai.okou.android.api.fixtures.ChatEvents
import ai.okou.android.api.fixtures.ChatEventsEventsItemVariant1
import ai.okou.android.api.fixtures.ChatEventsEventsItemVariant2
import ai.okou.android.api.fixtures.ChatSnapshot
import ai.okou.android.api.fixtures.ChatSnapshotVariant1
import ai.okou.android.api.fixtures.ChatSnapshotVariant2
import ai.okou.android.api.fixtures.IndicatorMap
import ai.okou.android.api.fixtures.Indicators
import ai.okou.android.api.fixtures.Projects
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

/** Exercises generated canonical readers, not handwritten approximations of their wire types. */
class ChatReadBindingsTest {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = true
    }
    private val wires =
        checkNotNull(javaClass.getResourceAsStream("/api-bindings/chat-list.json"))
            .bufferedReader()
            .use { json.parseToJsonElement(it.readText()).jsonObject }

    @Test
    fun snapshotBranchesReadAndRoundTripWithoutAnInventedTypeField() {
        val remote = json.decodeFromJsonElement<ChatSnapshot>(wire("snapshotRemote"))
        assertTrue(remote is ChatSnapshotVariant1)
        remote as ChatSnapshotVariant1
        assertEquals(17L, remote.latestSeqId)
        assertEquals("https://storage.example/chat-snapshot", remote.url)
        assertEquals(wire("snapshotRemote"), json.encodeToJsonElement<ChatSnapshot>(remote))

        val empty = json.decodeFromJsonElement<ChatSnapshot>(wire("snapshotEmpty"))
        assertTrue(empty is ChatSnapshotVariant2)
        empty as ChatSnapshotVariant2
        assertSame(CanonicalEmptyArray, empty.chatThreads)
        assertSame(JsonNull, empty.latestSeqId)
        assertEquals(wire("snapshotEmpty"), json.encodeToJsonElement<ChatSnapshot>(empty))

        val extended =
            JsonObject(wire("snapshotRemote").jsonObject + ("futureField" to JsonPrimitive(true)))
        assertEquals(remote, json.decodeFromJsonElement<ChatSnapshot>(extended))
        val nullable =
            JsonObject(
                wire("snapshotRemote").jsonObject +
                    mapOf("latestEventId" to JsonNull, "latestSeqId" to JsonNull)
            )
        assertNull(
            (json.decodeFromJsonElement<ChatSnapshot>(nullable) as ChatSnapshotVariant1)
                .latestEventId
        )
    }

    @Test
    fun lifecycleDiscriminatorPreservesOptionalVsRequiredNullableProjectAndMergedEfforts() {
        val page = json.decodeFromJsonElement<ChatEvents>(wire("events"))
        assertFalse(page.hasMore)
        val created = page.events[0] as ChatEventsEventsItemVariant1
        val moved = page.events[1] as ChatEventsEventsItemVariant2
        assertEquals(17L, created.seqId)
        assertEquals(23L, moved.seqId)
        assertNull(created.projectId)
        assertNull(moved.projectId)
        assertEquals(
            JsonPrimitive("extra"),
            json.encodeToJsonElement(created.modelSettings!!.getValue("claude-code/test").effort),
        )
        assertEquals(
            JsonPrimitive("ultra"),
            json.encodeToJsonElement(created.modelSettings.getValue("codex/test").effort),
        )
        assertEquals(wire("events"), json.encodeToJsonElement(page))

        val events = wire("events").jsonObject.getValue("events").jsonArray
        val missingProject = JsonObject(events[1].jsonObject - "projectId")
        assertDecodeFails<ChatEvents>(
            JsonObject(
                mapOf(
                    "events" to JsonArray(listOf(missingProject)),
                    "hasMore" to JsonPrimitive(false),
                )
            )
        )
    }

    @Test
    fun mapsRootArraysAndArchiveInputDefaultsCompileAndDecodeThroughRealSerializers() {
        val indicators = json.decodeFromJsonElement<Indicators>(wire("indicators"))
        assertEquals(
            JsonPrimitive("active"),
            json.encodeToJsonElement(indicators.agents.values.single()),
        )
        assertEquals(
            JsonPrimitive("unread"),
            json.encodeToJsonElement(indicators.threads.values.single()),
        )
        val map =
            json.decodeFromJsonElement<IndicatorMap>(
                wire("indicators").jsonObject.getValue("threads")
            )
        assertEquals(indicators.threads.keys, map.keys)

        val agents = json.decodeFromJsonElement<Agents>(wire("agents"))
        assertTrue(agents.single().isDefaultAgent)
        assertNull(agents.single().sound)
        assertDecodeFails<Agents>(
            JsonArray(listOf(JsonObject(wire("agents").jsonArray[0].jsonObject - "sound")))
        )
        val projects = json.decodeFromJsonElement<Projects>(wire("projects"))
        assertEquals("A project", projects.projects.single().name)

        val thread = json.decodeFromJsonElement<ChatArchive>(wire("archive")).chatThreads.single()
        assertNull(thread.selectedModel)
        assertNull(thread.computerUseHostId)
        // Canonical input accepts historical wire before its semantic/domain normalization.
        assertEquals(JsonPrimitive("ultrafast"), json.encodeToJsonElement(thread.serviceTier))
        assertEquals(
            JsonPrimitive("ultracode"),
            json.encodeToJsonElement(thread.modelSettings!!.getValue("claude-code/test").effort),
        )
    }

    @Test
    fun invalidUnionShapesAndExplicitEmptyOrNullValuesFailClosed() {
        val remote = wire("snapshotRemote").jsonObject
        val empty = wire("snapshotEmpty").jsonObject
        for (invalid in
            listOf(
                JsonObject(remote + ("chatThreads" to JsonArray(emptyList()))),
                JsonObject(
                    empty + ("chatThreads" to JsonArray(listOf(JsonPrimitive("not-empty"))))
                ),
                JsonObject(empty + ("latestSeqId" to JsonPrimitive(1))),
                JsonObject(remote - "latestEventId"),
                JsonArray(emptyList()),
            )) assertDecodeFails<ChatSnapshot>(invalid)

        val privateValue = "private-wire-value"
        val unknown =
            assertDecodeFails<ChatSnapshot>(
                JsonObject(mapOf("private" to JsonPrimitive(privateValue)))
            )
        assertFalse(unknown.message.orEmpty().contains(privateValue))
        val first = wire("events").jsonObject.getValue("events").jsonArray[0].jsonObject
        for (tag in listOf(JsonPrimitive(privateValue), JsonNull, JsonObject(emptyMap()))) {
            val invalid = JsonObject(first + ("kind" to tag))
            val error =
                assertDecodeFails<ChatEvents>(
                    JsonObject(
                        mapOf(
                            "events" to JsonArray(listOf(invalid)),
                            "hasMore" to JsonPrimitive(false),
                        )
                    )
                )
            assertFalse(error.message.orEmpty().contains(privateValue))
        }
    }

    @Test
    fun generatedRetrofitQueriesOmitAbsentCursorAndDecodeRootArrays() = runTest {
        val http = OkHttpClient()
        try {
            MockWebServer().use { server ->
                server.start()
                val api =
                    Retrofit.Builder()
                        .baseUrl(server.url("/"))
                        .client(http)
                        .addConverterFactory(
                            json.asConverterFactory("application/json".toMediaType())
                        )
                        .build()
                        .create(FixtureApi::class.java)
                repeat(2) { server.enqueue(MockResponse().setBody(wire("events").toString())) }
                assertEquals(2, api.chatEvents("Bearer fixture").body()!!.events.size)
                assertEquals("/api/chat-threads/events", server.takeRequest().path)
                api.chatEvents("Bearer fixture", querySinceSeqId = 17)
                val request = server.takeRequest()
                assertEquals("/api/chat-threads/events?sinceSeqId=17", request.path)
                assertEquals("Bearer fixture", request.getHeader("Authorization"))
                server.enqueue(MockResponse().setBody(wire("agents").toString()))
                assertTrue(api.agents("Bearer fixture").body()!!.single().isDefaultAgent)
                assertEquals("/api/agents", server.takeRequest().path)
            }
        } finally {
            http.closeTransport()
        }
    }

    private fun wire(name: String): JsonElement = wires.getValue(name)

    private inline fun <reified T> assertDecodeFails(value: JsonElement): SerializationException =
        assertThrows(SerializationException::class.java) { json.decodeFromJsonElement<T>(value) }
}
