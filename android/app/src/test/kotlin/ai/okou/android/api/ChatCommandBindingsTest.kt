package ai.okou.android.api

import ai.okou.android.api.commandfixtures.AcceptedInput
import ai.okou.android.api.commandfixtures.CanonicalApi as CommandApi
import ai.okou.android.api.commandfixtures.CanonicalInteger1
import ai.okou.android.api.commandfixtures.CanonicalOptional
import ai.okou.android.api.commandfixtures.CreateThreadRequest
import ai.okou.android.api.commandfixtures.CreatedThread
import ai.okou.android.api.commandfixtures.SendRequest
import ai.okou.android.api.commandfixtures.SendRequestVariant1
import ai.okou.android.api.commandfixtures.SendRequestVariant2
import ai.okou.android.api.commandfixtures.SendRequestVariant3
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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

/** Generated command DTOs are compiled and exercised at the actual codec and HTTP boundaries. */
class ChatCommandBindingsTest {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = true
    }
    private val wires =
        checkNotNull(javaClass.getResourceAsStream("/api-bindings/chat-commands.json"))
            .bufferedReader()
            .use { json.parseToJsonElement(it.readText()).jsonObject }

    @Test
    fun creationKeepsOmittedNullAndExplicitSelectionsDistinct() {
        for (name in listOf("createDefaults", "createAuto", "createPinned")) {
            val value = json.decodeFromJsonElement<CreateThreadRequest>(wire(name))
            assertEquals(wire(name), json.encodeToJsonElement(value))
        }
        val defaults = json.decodeFromJsonElement<CreateThreadRequest>(wire("createDefaults"))
        assertSame(CanonicalOptional.Absent, defaults.model)
        val explicitAuto = defaults.copy(model = CanonicalOptional.Present(null))
        assertEquals(
            JsonObject(wire("createDefaults").jsonObject + ("model" to JsonNull)),
            json.encodeToJsonElement(explicitAuto),
        )
        val created = json.decodeFromJsonElement<CreatedThread>(wire("created"))
        assertNull(created.selectedModel)
        assertNull(created.serviceTier)
        assertEquals(wire("created"), json.encodeToJsonElement(created))
    }

    @Test
    fun commandVariantsKeepStableIdentityStructuredTextAndCompoundSourceTags() {
        for (name in
            listOf(
                "newInput",
                "existingInput",
                "explicitInput",
                "pinnedInput",
                "sourcedInput",
                "externalInput",
                "forwardedInput",
                "revoke",
                "interrupt",
            )) {
            val value = json.decodeFromJsonElement<SendRequest>(wire(name))
            assertEquals(wire(name), json.encodeToJsonElement<SendRequest>(value))
        }
        val fresh = json.decodeFromJsonElement<SendRequest>(wire("newInput")) as SendRequestVariant1
        assertSame(CanonicalInteger1, fresh.userMessage.version)
        assertEquals(
            wire("newInput").jsonObject.getValue("clientEventId").jsonPrimitive.content,
            fresh.clientEventId,
        )
        val existing =
            json.decodeFromJsonElement<SendRequest>(wire("existingInput")) as SendRequestVariant1
        assertEquals(fresh.clientThreadId, existing.threadId)
        assertEquals(fresh.prompt, existing.prompt)
        assertTrue(json.decodeFromJsonElement<SendRequest>(wire("revoke")) is SendRequestVariant2)
        assertTrue(
            json.decodeFromJsonElement<SendRequest>(wire("interrupt")) is SendRequestVariant3
        )
    }

    @Test
    fun invalidVersionOrOverlappingCommandCannotBeSilentlyReinterpreted() {
        val input = wire("existingInput").jsonObject
        val document = input.getValue("userMessage").jsonObject
        for (version in listOf(JsonPrimitive(2), JsonPrimitive("1"), JsonNull)) {
            assertDecodeFails<SendRequest>(
                JsonObject(input + ("userMessage" to JsonObject(document + ("version" to version))))
            )
        }
        val privateValue = "private-command-text"
        val overlap =
            JsonObject(
                input +
                    mapOf(
                        "prompt" to JsonPrimitive(privateValue),
                        "interruptsRunId" to JsonPrimitive("77777777-7777-4777-8777-777777777777"),
                    )
            )
        val error = assertDecodeFails<SendRequest>(overlap)
        assertFalse(error.message.orEmpty().contains(privateValue))
        val source =
            JsonObject(
                mapOf(
                    "type" to JsonPrimitive("source"),
                    "kind" to JsonPrimitive("unknown"),
                    "clientId" to JsonPrimitive("fixture-client"),
                )
            )
        val badSource = JsonObject(document + ("parts" to JsonArray(listOf(source))))
        assertDecodeFails<SendRequest>(JsonObject(input + ("userMessage" to badSource)))
    }

    @Test
    fun generatedRequestsUseCanonicalPathsBodiesAndAccepted201Receipts() = runTest {
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
                        .create(CommandApi::class.java)
                val create = json.decodeFromJsonElement<CreateThreadRequest>(wire("createAuto"))
                server.enqueue(
                    MockResponse().setResponseCode(201).setBody(wire("created").toString())
                )
                val created = api.createThread("Bearer fixture", create)
                assertEquals(201, created.code())
                assertEquals(
                    wire("created"),
                    json.encodeToJsonElement(checkNotNull(created.body())),
                )
                val request = server.takeRequest()
                assertEquals("POST", request.method)
                assertEquals("/api/chat-threads", request.path)
                assertEquals("Bearer fixture", request.getHeader("Authorization"))
                assertEquals(wire("createAuto"), json.parseToJsonElement(request.body.readUtf8()))

                for (name in listOf("newInput", "existingInput", "explicitInput")) {
                    server.enqueue(
                        MockResponse().setResponseCode(201).setBody(wire("accepted").toString())
                    )
                    val input = json.decodeFromJsonElement<SendRequest>(wire(name))
                    val accepted = api.send("Bearer fixture", input)
                    assertEquals(201, accepted.code())
                    assertEquals(
                        checkNotNull(created.body()).id,
                        checkNotNull(accepted.body()).threadId,
                    )
                    val sent = server.takeRequest()
                    assertEquals("POST", sent.method)
                    assertEquals("/api/chat/events", sent.path)
                    assertEquals("Bearer fixture", sent.getHeader("Authorization"))
                    assertEquals(wire(name), json.parseToJsonElement(sent.body.readUtf8()))
                }
                server.enqueue(
                    MockResponse()
                        .setResponseCode(503)
                        .setBody("""{"error":{"code":"UNAVAILABLE","message":"retry later"}}""")
                )
                val unavailable =
                    api.send(
                        "Bearer fixture",
                        json.decodeFromJsonElement<SendRequest>(wire("existingInput")),
                    )
                assertEquals(503, unavailable.code())
                assertNull(unavailable.body())
                unavailable.errorBody()?.close()
                server.takeRequest()
                val accepted =
                    json.decodeFromJsonElement<AcceptedInput>(wire("acceptedWithoutDate"))
                assertNull(accepted.createdAt)
            }
        } finally {
            http.closeTransport()
        }
    }

    private fun wire(name: String): JsonElement = wires.getValue(name)

    private inline fun <reified T> assertDecodeFails(value: JsonElement): SerializationException =
        assertThrows(SerializationException::class.java) { json.decodeFromJsonElement<T>(value) }
}
