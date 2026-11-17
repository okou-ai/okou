package ai.okou.android.api

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ComposerApiFixture
import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.SendRequestVariant1
import ai.okou.android.chat.HistoryCursor
import ai.okou.android.chat.HistoryEvent
import ai.okou.android.chat.ServerDraftTarget
import ai.okou.android.chat.TextDisposition
import ai.okou.android.chat.plainText
import java.util.UUID
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class ChatComposerApiTest {
    @Test
    fun canonicalDraftsRoundTripBothTargetsAndAcceptActualEmpty204Responses() = runTest {
        ComposerApiFixture().use { fixture ->
            val targets =
                listOf(ServerDraftTarget(CHAT_AGENT, false), ServerDraftTarget(CHAT_PERSONAL, true))
            for (target in targets) {
                assertEquals("", fixture.service.composerDraft(target).plainText())
                val text = "Web ↔ Android 你好 👋\n**literal**"
                fixture.service.saveComposerDraft(target, text)
                assertEquals(text, fixture.service.composerDraft(target).plainText())
                val patch = fixture.requests.last { it.method == "PATCH" }
                assertEquals(
                    if (target.thread) "/api/chat-threads/${target.id}"
                    else "/api/agents/${target.id}/draft",
                    patch.requestUrl!!.encodedPath,
                )
                val wire = Json.parseToJsonElement(patch.body.clone().readUtf8())
                assertEquals(
                    Json.parseToJsonElement(
                        """{"draftUserMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(text)}}]},"draftAttachments":null}"""
                    ),
                    wire,
                )
                assertTrue(patch.getHeader("Authorization")!!.startsWith("Bearer "))
                fixture.service.saveComposerDraft(target, "")
                assertEquals("", fixture.service.composerDraft(target).plainText())
            }
        }
    }

    private fun input(thread: String, text: String = "你好 👋\n**verbatim**") =
        Json.decodeFromJsonElement<SendRequestVariant1>(
            Json.parseToJsonElement(
                """{"agentId":"$CHAT_AGENT","threadId":"$thread","clientEventId":"${UUID.randomUUID()}","chatThreadSortEventId":"${UUID.randomUUID()}","prompt":${JsonPrimitive(text)},"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(text)}}]},"hasTextContent":true}"""
            )
        )

    @Test
    fun batchAndPerThreadHistoryShareAcceptedInputsAndContinueTheSameCursor() = runTest {
        ComposerApiFixture().use { fixture ->
            val thread =
                fixture.service
                    .createThread(
                        CreateThreadRequest(
                            agentId = CHAT_AGENT,
                            clientThreadId = UUID.randomUUID().toString(),
                            eventId = UUID.randomUUID().toString(),
                        )
                    )
                    .id
            val cold =
                listOf(CHAT_PERSONAL, CHAT_IN_PROJECT, thread).associateWith { HistoryCursor() }
            val empty = fixture.service.historyCatchUp(cold)
            assertEquals(cold.mapValues { emptyList<HistoryEvent>() }, empty.events)
            assertTrue(empty.notFoundThreads.isEmpty())
            cold.forEach { (id, cursor) ->
                val page = fixture.service.historyRows(id, cursor)
                assertTrue(page.rows.isEmpty())
                assertEquals(cursor, page.cursor)
                assertFalse(page.hasMore)
            }

            val first = input(CHAT_PERSONAL)
            val other = input(thread, "Created conversation")
            fixture.service.sendInput(first)
            fixture.service.sendInput(other)
            val initial = fixture.service.historyRows(CHAT_PERSONAL, HistoryCursor())
            assertEquals(listOf(first.clientEventId), initial.rows.map { it.id })
            val second = input(CHAT_PERSONAL, "Next message after the cursor")
            fixture.service.sendInput(second)

            val cursors = cold + (CHAT_PERSONAL to initial.cursor)
            val batch = fixture.service.historyCatchUp(cursors)
            assertEquals(
                mapOf(
                    CHAT_PERSONAL to listOf(second.clientEventId),
                    CHAT_IN_PROJECT to emptyList<String>(),
                    thread to listOf(other.clientEventId),
                ),
                batch.events.mapValues { (_, rows) -> rows.map { it.id } },
            )
            val tails =
                cursors.mapValues { (id, cursor) ->
                    val page = fixture.service.historyRows(id, cursor)
                    assertEquals(batch.events.getValue(id), page.rows)
                    assertFalse(page.hasMore)
                    page.cursor
                }
            val full = fixture.service.historyRows(CHAT_PERSONAL, HistoryCursor())
            assertEquals(listOf(first.clientEventId, second.clientEventId), full.rows.map { it.id })
            for ((request, row) in
                listOf(
                    first to full.rows[0],
                    second to full.rows[1],
                    other to batch.events.getValue(thread).single(),
                )) {
                assertEquals(request.threadId, row.threadId)
                assertEquals("input.prompt", row.type)
                assertEquals(Json.encodeToJsonElement(request.userMessage), row.userMessage)
            }
            val caughtUp = fixture.service.historyCatchUp(tails)
            assertEquals(tails.mapValues { emptyList<HistoryEvent>() }, caughtUp.events)
            tails.forEach { (id, cursor) ->
                val page = fixture.service.historyRows(id, cursor)
                assertTrue(page.rows.isEmpty())
                assertEquals(cursor, page.cursor)
                assertFalse(page.hasMore)
            }
        }
    }

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
