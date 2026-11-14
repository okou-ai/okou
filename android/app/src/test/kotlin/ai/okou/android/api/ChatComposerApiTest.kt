package ai.okou.android.api

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ComposerApiFixture
import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.SendRequestVariant1
import ai.okou.android.chat.TextDisposition
import java.util.UUID
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class ChatComposerApiTest {
    private fun input(thread: String, text: String = "你好 👋\n**verbatim**") =
        Json.decodeFromJsonElement<SendRequestVariant1>(
            Json.parseToJsonElement(
                """{"agentId":"$CHAT_AGENT","threadId":"$thread","clientEventId":"${UUID.randomUUID()}","chatThreadSortEventId":"${UUID.randomUUID()}","prompt":${JsonPrimitive(text)},"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(text)}}]},"hasTextContent":true}"""
            )
        )

    @Test
    fun installedCreateAndSendUse201CanonicalDefaultsAndOriginalInputStatus() = runTest {
        ComposerApiFixture().use { fixture ->
            assertEquals(CHAT_AGENT, fixture.service.newChatAgent())
            val thread = UUID.randomUUID().toString()
            val created =
                fixture.service.createThread(
                    CreateThreadRequest(
                        agentId = CHAT_AGENT,
                        projectId = CHAT_PROJECT,
                        clientThreadId = thread,
                        eventId = UUID.randomUUID().toString(),
                    )
                )
            assertEquals(thread, created.id)
            assertEquals(CHAT_PROJECT, created.projectId)
            val create = fixture.created.single()
            assertFalse(create.containsKey("model"))
            assertFalse(create.containsKey("serviceTier"))
            val send = input(thread)
            assertEquals(thread, fixture.service.sendInput(send).threadId)
            val wire = fixture.inputs.values.single()
            for (key in
                listOf(
                    "model",
                    "computerUseHostId",
                    "cloudBrowserEnabled",
                    "connectorSelections",
                )) assertFalse(wire.containsKey(key))
            assertEquals(send.prompt, wire.getValue("prompt").jsonPrimitive.content)
            val observed = fixture.service.observeInput(thread, checkNotNull(send.clientEventId))
            assertEquals(TextDisposition.Queued, observed.disposition)
            assertEquals(send.clientEventId, observed.eventId)
            assertTrue(
                fixture.requests.all { it.getHeader("Authorization") == "Bearer fixture-token" }
            )
        }
    }

    @Test
    fun disconnectedAcceptanceIsObservedWithoutAutomaticPostReplay() = runTest {
        ComposerApiFixture().use { fixture ->
            fixture.disconnectSend = true
            val request = input(CHAT_PERSONAL)
            try {
                fixture.service.sendInput(request)
                fail("Response should disconnect")
            } catch (_: ApiFailure.Network) {}
            assertEquals(1, fixture.inputs.size)
            assertEquals(1, fixture.requests.count { it.method == "POST" })
            assertEquals(
                TextDisposition.Queued,
                fixture.service
                    .observeInput(CHAT_PERSONAL, checkNotNull(request.clientEventId))
                    .disposition,
            )
            fixture.disconnectSend = false
            assertEquals(CHAT_PERSONAL, fixture.service.sendInput(request).threadId)
            assertEquals(1, fixture.inputs.size)
            assertEquals(2, fixture.requests.count { it.method == "POST" })
        }
    }

    @Test
    fun unavailableStatusAndRejectedInputRemainDifferentCanonicalObservations() = runTest {
        ComposerApiFixture().use { fixture ->
            val request = input(CHAT_PERSONAL)
            assertNull(
                fixture.service
                    .observeInput(CHAT_PERSONAL, checkNotNull(request.clientEventId))
                    .disposition
            )
            fixture.service.sendInput(request)
            fixture.inputDisposition = "rejected"
            assertEquals(
                TextDisposition.Rejected,
                fixture.service
                    .observeInput(CHAT_PERSONAL, checkNotNull(request.clientEventId))
                    .disposition,
            )
            for ((wire, expected) in
                mapOf(
                    "consumed" to TextDisposition.Consumed,
                    "completed" to TextDisposition.Completed,
                    "failed" to TextDisposition.Failed,
                    "cancelled" to TextDisposition.Cancelled,
                    "revoked" to TextDisposition.Revoked,
                )) {
                fixture.inputDisposition = wire
                val observed =
                    fixture.service.observeInput(CHAT_PERSONAL, checkNotNull(request.clientEventId))
                assertEquals(request.clientEventId, observed.eventId)
                assertEquals(expected, observed.disposition)
            }
        }
    }
}
