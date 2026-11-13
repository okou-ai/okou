package ai.okou.android.api

import ai.okou.android.api.historyfixtures.CanonicalApi as HistoryApi
import ai.okou.android.api.historyfixtures.CanonicalOptionalJson
import ai.okou.android.api.historyfixtures.CanonicalZero
import ai.okou.android.api.historyfixtures.HistoryRows
import ai.okou.android.api.historyfixtures.HistoryRowsCursorVariant1
import ai.okou.android.api.historyfixtures.HistoryRowsCursorVariant2
import ai.okou.android.api.historyfixtures.HistorySnapshot
import ai.okou.android.api.historyfixtures.HistorySnapshotVariant1
import ai.okou.android.api.historyfixtures.HistorySnapshotVariant2
import ai.okou.android.api.historyfixtures.RawHistoryRow
import ai.okou.android.api.historyfixtures.RawHistoryRowVariant1
import ai.okou.android.api.historyfixtures.RawHistoryRowVariant2
import ai.okou.android.api.historyfixtures.RawHistoryRowVariant3
import ai.okou.android.api.historyfixtures.RowsQuery
import ai.okou.android.api.historyfixtures.RowsQueryVariant1
import ai.okou.android.api.historyfixtures.RowsQueryVariant2
import ai.okou.android.api.historyfixtures.rows
import ai.okou.android.api.historyfixtures.toQueryParameters
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
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

/** Actual canonical schemas compiled and exercised through native codecs and HTTP. */
class ChatHistoryBindingsTest {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = true
    }
    private val wires =
        checkNotNull(javaClass.getResourceAsStream("/api-bindings/chat-history.json"))
            .bufferedReader()
            .use { json.parseToJsonElement(it.readText()).jsonObject }
    private val threadId = "11111111-1111-4111-8111-111111111111"
    private val eventId = "44444444-4444-4444-8444-444444444444"

    @Test
    fun pairedSnapshotAndPageCursorsPreserveLiteralZeroAndPositiveProgress() {
        val cold =
            json.decodeFromJsonElement<HistorySnapshot>(wire("snapshotEmpty"))
                as HistorySnapshotVariant1
        assertSame(CanonicalZero, cold.lastSeqId)
        assertSame(JsonNull, cold.lastEventId)
        val warm =
            json.decodeFromJsonElement<HistorySnapshot>(wire("snapshotWarm"))
                as HistorySnapshotVariant2
        assertEquals(37L, warm.lastSeqId)
        assertEquals(eventId, warm.lastEventId)
        assertEquals(wire("snapshotEmpty"), json.encodeToJsonElement<HistorySnapshot>(cold))
        assertEquals(wire("snapshotWarm"), json.encodeToJsonElement<HistorySnapshot>(warm))
        val page = json.decodeFromJsonElement<HistoryRows>(wire("page"))
        assertEquals(37L, (page.cursor as HistoryRowsCursorVariant2).lastSeqId)
        assertFalse(page.hasMore)
        assertEquals(wire("page"), json.encodeToJsonElement(page))
        val empty = json.decodeFromJsonElement<HistoryRows>(wire("pageEmpty"))
        assertSame(CanonicalZero, (empty.cursor as HistoryRowsCursorVariant1).lastSeqId)
        assertEquals(wire("pageEmpty"), json.encodeToJsonElement(empty))

        val base = wire("snapshotWarm").jsonObject
        for (invalid in
            listOf(
                JsonObject(base - "lastEventId"),
                JsonObject(base + ("lastEventId" to JsonNull)),
                JsonObject(base + ("lastSeqId" to JsonPrimitive(0))),
                JsonObject(base + ("lastSeqId" to JsonPrimitive(-1))),
                JsonObject(wire("snapshotEmpty").jsonObject + ("lastSeqId" to JsonPrimitive("0"))),
            )) assertDecodeFails<HistorySnapshot>(invalid)
    }

    @Test
    fun rawRowsKeepTypedVariantsAndOpaquePayloadIncludingExplicitNull() {
        val rows = wire("page").jsonObject.getValue("rows").jsonArray
        val input = json.decodeFromJsonElement<RawHistoryRow>(rows[0]) as RawHistoryRowVariant2
        val output = json.decodeFromJsonElement<RawHistoryRow>(rows[1]) as RawHistoryRowVariant3
        val failed = json.decodeFromJsonElement<RawHistoryRow>(rows[2]) as RawHistoryRowVariant1
        val revoked = json.decodeFromJsonElement<RawHistoryRow>(rows[3]) as RawHistoryRowVariant3
        val usage = json.decodeFromJsonElement<RawHistoryRow>(rows[4]) as RawHistoryRowVariant3
        assertEquals(
            listOf(17L, 23L, 29L, 32L, 37L),
            listOf(input.seqId, output.seqId, failed.seqId, revoked.seqId, usage.seqId),
        )
        assertEquals(
            rows[0].jsonObject.getValue("payload").jsonObject.getValue("userMessage"),
            (input.payload!!.userMessage as CanonicalOptionalJson.Present).value,
        )
        assertSame(CanonicalOptionalJson.Absent, input.payload.usage)
        assertSame(JsonNull, (output.payload!!.userMessage as CanonicalOptionalJson.Present).value)
        assertEquals("runner_failed", failed.failureReason)
        assertEquals("input", revoked.revokesEventId)
        assertNull(revoked.payload)
        assertEquals(eventId, usage.id)
        assertEquals(
            rows[4].jsonObject.getValue("payload").jsonObject.getValue("usage"),
            (usage.payload!!.usage as CanonicalOptionalJson.Present).value,
        )
        for (row in rows) assertEquals(
            row,
            json.encodeToJsonElement<RawHistoryRow>(json.decodeFromJsonElement<RawHistoryRow>(row)),
        )
        val explicitNullUsage =
            JsonObject(rows[4].jsonObject + ("payload" to JsonObject(mapOf("usage" to JsonNull))))
        assertEquals(
            explicitNullUsage,
            json.encodeToJsonElement<RawHistoryRow>(
                json.decodeFromJsonElement<RawHistoryRow>(explicitNullUsage)
            ),
        )
    }

    @Test
    fun prohibitedFieldsAndUnknownDiscriminatorsFailWithPayloadFreeSelectorErrors() {
        val rows = wire("page").jsonObject.getValue("rows").jsonArray
        val privateValue = "private-payload-marker"
        for (row in listOf(rows[0], rows[1])) {
            for (forbidden in listOf(JsonNull, JsonPrimitive(privateValue))) {
                val error =
                    assertDecodeFails<RawHistoryRow>(
                        JsonObject(row.jsonObject + ("failureReason" to forbidden))
                    )
                assertFalse(error.message.orEmpty().contains(privateValue))
            }
        }
        val error =
            assertDecodeFails<RawHistoryRow>(
                JsonObject(rows[1].jsonObject + ("eventType" to JsonPrimitive(privateValue)))
            )
        assertFalse(error.message.orEmpty().contains(privateValue))
        assertDecodeFails<RawHistoryRow>(JsonObject(rows[0].jsonObject - "contextType"))
    }

    @Test
    fun typedQueriesKeepCanonicalColdAndWarmBranchesAndValidateBeforeSending() {
        val cold = json.decodeFromJsonElement<RowsQuery>(wire("queryCold")) as RowsQueryVariant1
        val warm = json.decodeFromJsonElement<RowsQuery>(wire("queryWarm")) as RowsQueryVariant2
        assertEquals(mapOf("sinceSeqId" to "0", "limit" to "50.0"), cold.toQueryParameters())
        assertEquals(
            mapOf("sinceSeqId" to "37", "sinceEventId" to eventId, "limit" to "12.5"),
            warm.toQueryParameters(),
        )
        assertEquals(
            cold,
            json.decodeFromJsonElement<RowsQuery>(json.encodeToJsonElement<RowsQuery>(cold)),
        )
        assertEquals(wire("queryWarm"), json.encodeToJsonElement<RowsQuery>(warm))
        for (invalid in
            listOf(
                warm.copy(sinceSeqId = 0),
                warm.copy(sinceSeqId = -1),
                warm.copy(sinceSeqId = 9007199254740992L),
                warm.copy(sinceEventId = "invalid"),
                warm.copy(limit = 0.0),
                warm.copy(limit = 51.0),
            )) assertThrows(IllegalArgumentException::class.java) { invalid.toQueryParameters() }
        assertDecodeFails<RowsQuery>(
            JsonObject(wire("queryCold").jsonObject + ("sinceEventId" to JsonNull))
        )
        assertDecodeFails<RowsQuery>(JsonObject(wire("queryWarm").jsonObject - "sinceEventId"))
    }

    @Test
    fun generatedRetrofitUsesEscapedPathsPairedQueriesAndAnEmptyMarkReadBody() = runTest {
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
                        .create(HistoryApi::class.java)
                server.enqueue(MockResponse().setBody(wire("snapshotEmpty").toString()))
                assertTrue(
                    api.snapshot("Bearer fixture", "thread/part ?").body()
                        is HistorySnapshotVariant1
                )
                assertEquals(
                    "/api/chat-threads/thread%2Fpart%20%3F/event-snapshot",
                    server.takeRequest().path,
                )

                server.enqueue(MockResponse().setBody(wire("pageEmpty").toString()))
                api.rows("Bearer fixture", threadId, RowsQueryVariant1(CanonicalZero, 50.0))
                val cold = server.takeRequest()
                assertEquals(
                    "/api/chat-threads/$threadId/event-rows?sinceSeqId=0&limit=50.0",
                    cold.path,
                )
                assertEquals("Bearer fixture", cold.getHeader("Authorization"))
                server.enqueue(MockResponse().setBody(wire("page").toString()))
                assertEquals(
                    5,
                    api.rows("Bearer fixture", threadId, RowsQueryVariant2(37, eventId, 12.5))
                        .body()!!
                        .rows
                        .size,
                )
                assertEquals(
                    "/api/chat-threads/$threadId/event-rows?sinceSeqId=37&sinceEventId=$eventId&limit=12.5",
                    server.takeRequest().path,
                )

                server.enqueue(MockResponse().setBody(wire("detail").toString()))
                assertNull(api.detail("Bearer fixture", threadId).body()!!.lastReadAt)
                assertEquals("/api/chat-threads/$threadId", server.takeRequest().path)
                server.enqueue(MockResponse().setBody(wire("readState").toString()))
                assertEquals(
                    "2026-11-13T00:00:00.000Z",
                    api.markRead("Bearer fixture", threadId).body()!!.lastReadAt,
                )
                val read = server.takeRequest()
                assertEquals("POST", read.method)
                assertEquals("/api/chat-threads/$threadId/mark-read", read.path)
                assertEquals(0L, read.bodySize)

                val beforeInvalid = server.requestCount
                server.enqueue(MockResponse().setBody(wire("pageEmpty").toString()))
                try {
                    api.rows("Bearer fixture", threadId, RowsQueryVariant1(CanonicalZero, 0.0))
                    fail("Invalid query must fail before HTTP")
                } catch (_: IllegalArgumentException) {
                    /* canonical query constraint */
                }
                assertEquals(beforeInvalid, server.requestCount)
            }
        } finally {
            http.closeTransport()
        }
    }

    private fun wire(name: String): JsonElement = wires.getValue(name)

    private inline fun <reified T> assertDecodeFails(value: JsonElement): SerializationException =
        assertThrows(SerializationException::class.java) { json.decodeFromJsonElement<T>(value) }
}
