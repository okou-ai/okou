package ai.okou.android.chat

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.HISTORY_RUN
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.SessionOutputDelta
import ai.okou.android.historyEventWire
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class RunOutputModelTest {
    private val eventId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

    private fun delta(index: Long, text: String = "piece", id: String = eventId) =
        RunOutputSignal.Delta(
            SessionOutputDelta(
                CHAT_PERSONAL,
                HISTORY_RUN,
                id,
                if (id == eventId) "message" else id,
                "2026-11-16T00:00:00Z",
                index,
                text,
            )
        )

    private class Owner {
        var current =
            ConversationUiState(
                thread =
                    Json.decodeFromString<ChatArchive>(
                            """{"chatThreads":[{"id":"$CHAT_PERSONAL","agentId":"agent","projectId":null,"title":"Thread","sortAt":"2026-11-16T00:00:00Z","createdAt":"2026-11-16T00:00:00Z","updatedAt":"2026-11-16T00:00:00Z","pinnedAt":null,"archived":false,"renamedAt":null}]}"""
                        )
                        .chatThreads
                        .single(),
                transcript =
                    HistoryTranscript(emptyList(), HistoryExecution.Running, 0, HISTORY_RUN),
                source = ChatListSource.Network,
            )
        var authorized = true
        var reads = 0
        val model = RunOutputModel({ current }, { authorized }, { reads++ })

        init {
            model.visible(true)
        }

        val target
            get() = checkNotNull(model.target.value)

        fun persisted(vararg events: HistoryEvent) {
            current =
                current.copy(
                    transcript =
                        projectHistory(
                            HistoryCheckpoint(
                                CHAT_PERSONAL,
                                events.toList(),
                                HistoryCursor(events.last().id, events.last().seqId),
                            )
                        )
                )
            model.reconcile()
        }
    }

    @Test
    fun contiguousChunksDuplicateAndPersistedPrecedenceUseOneStableMessage() {
        val owner = Owner()
        val target = owner.target
        owner.model.receive(target, delta(0, "Hello "))
        owner.model.receive(target, delta(0, "duplicate"))
        owner.model.receive(target, delta(1, "world"))
        assertEquals("Hello world", owner.model.state.value.messages.single().blocks.single().text)
        // Rendering chooses persistence even before the projection's reconcile callback runs.
        val row =
            HistoryEvent.decode(
                historyEventWire(eventId, 1, payload = """{"content":"Saved answer"}""")
            )
        val transcript =
            projectHistory(
                HistoryCheckpoint(CHAT_PERSONAL, listOf(row), HistoryCursor(row.id, row.seqId))
            )
        assertEquals(
            "Saved answer",
            transcript
                .withOutput(owner.model.state.value, CHAT_PERSONAL)
                .single()
                .blocks
                .single()
                .text,
        )
        owner.current = owner.current.copy(transcript = transcript)
        owner.model.reconcile()
        assertTrue(owner.model.state.value.messages.isEmpty())
        owner.model.receive(target, delta(2, "late"))
        assertTrue(owner.model.state.value.messages.isEmpty())
    }

    @Test
    fun gapAndTransportLossKeepObservedPrefixAndRejectUnverifiedContinuation() {
        val owner = Owner()
        owner.model.receive(owner.target, delta(2, "no prefix"))
        assertTrue(owner.model.state.value.messages.isEmpty())
        owner.model.receive(owner.target, delta(0, "Keep me"))
        owner.model.receive(owner.target, delta(2, "missing middle"))
        owner.model.receive(owner.target, delta(1, "late middle"))
        owner.model.transport(RealtimePhase.Unavailable)
        assertEquals("Keep me", owner.model.state.value.messages.single().blocks.single().text)
        assertEquals(RunOutputPhase.CatchingUp, owner.model.state.value.phase)
        assertTrue(owner.reads > 0)
    }

    @Test
    fun targetVisibilityAuthThreadAndTerminalFencesRejectLateCallbacks() {
        val owner = Owner()
        val old = owner.target
        owner.model.receive(old, delta(0, "prefix"))
        owner.model.visible(false)
        owner.model.visible(true)
        assertNotEquals(old, owner.target)
        owner.model.receive(old, delta(1, "old visit"))
        owner.authorized = false
        owner.model.receive(owner.target, delta(1, "retired auth"))
        owner.authorized = true
        owner.model.receive(
            owner.target,
            RunOutputSignal.Delta(delta(1).value.copy(threadId = "other")),
        )
        val terminal =
            HistoryEvent.decode(
                historyEventWire("terminal", 1, type = "run.completed", payload = "null")
            )
        owner.persisted(terminal)
        assertNull(owner.model.target.value)
        owner.model.receive(old, delta(1, "terminal late"))
        assertEquals("prefix", owner.model.state.value.messages.single().blocks.single().text)
        owner.current = owner.current.copy(generation = 1)
        owner.model.reconcile()
        assertTrue(owner.model.state.value.messages.isEmpty())
    }

    @Test
    fun cacheAndQueuedInputDoNotSubscribeAndRetainedMemoryIsBounded() {
        val owner = Owner()
        owner.current = owner.current.copy(source = ChatListSource.Cache)
        owner.model.reconcile()
        assertNull(owner.model.target.value)
        owner.current = owner.current.copy(source = ChatListSource.Network)
        owner.model.reconcile()
        owner.model.receive(owner.target, delta(0, "x".repeat(RunOutputModel.MAX_CHARACTERS - 7)))
        owner.model.receive(owner.target, delta(1, "overflow"))
        assertEquals(
            RunOutputModel.MAX_CHARACTERS - 7,
            owner.model.state.value.messages.single().blocks.single().text.length,
        )
        assertEquals(RunOutputPhase.CatchingUp, owner.model.state.value.phase)
        owner.current =
            owner.current.copy(
                transcript = HistoryTranscript(emptyList(), HistoryExecution.Queued, 0)
            )
        owner.model.reconcile()
        assertNull(owner.model.target.value)
        owner.model.close()
        assertTrue(owner.model.state.value.messages.isEmpty())
    }

    @Test
    fun identitiesAndRevocationsCannotMixAndMessageCountIsBounded() {
        val owner = Owner()
        owner.model.receive(owner.target, delta(0, "first"))
        val changedIdentity = delta(1).value.copy(runEventId = "different")
        owner.model.receive(owner.target, RunOutputSignal.Delta(changedIdentity))
        assertEquals("first", owner.model.state.value.messages.single().blocks.single().text)
        owner.model.receive(
            owner.target,
            RunOutputSignal.Delta(delta(0).value.copy(eventId = "other-event")),
        )
        assertEquals(1, owner.model.state.value.messages.size)
        repeat(RunOutputModel.MAX_MESSAGES) {
            owner.model.receive(owner.target, delta(0, "next", "id-$it"))
        }
        assertEquals(RunOutputModel.MAX_MESSAGES, owner.model.state.value.messages.size)
        assertEquals(RunOutputPhase.CatchingUp, owner.model.state.value.phase)
        val revoked =
            HistoryEvent.decode(
                historyEventWire(
                    "revocation",
                    1,
                    type = "control.revoke",
                    revoke = eventId,
                    payload = "null",
                )
            )
        owner.persisted(revoked)
        assertFalse(owner.model.state.value.messages.any { it.id == eventId })
    }

    @Test
    fun outputStaysWithItsRunBeforeLaterInputsAndCapacityRecoversAfterPersistence() {
        val owner = Owner()
        owner.model.receive(owner.target, delta(0, "first"))
        val first = HistoryMessage("input", HISTORY_RUN, HistoryRole.User, emptyList())
        val nextRun = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val next = HistoryMessage("next", nextRun, HistoryRole.User, emptyList())
        val queued = HistoryMessage("queued", null, HistoryRole.User, emptyList())
        val transcript =
            HistoryTranscript(listOf(first, next, queued), HistoryExecution.Running, 0, nextRun)
        assertEquals(
            listOf("input", eventId, "next", "queued"),
            transcript.withOutput(owner.model.state.value, CHAT_PERSONAL).map { it.id },
        )
        owner.model.receive(owner.target, delta(1, "x".repeat(RunOutputModel.MAX_CHARACTERS)))
        owner.current =
            owner.current.copy(
                transcript = owner.current.transcript!!.copy(persistedIds = setOf(eventId))
            )
        owner.model.reconcile()
        owner.model.receive(owner.target, delta(0, "new message", "next-event"))
        assertEquals("new message", owner.model.state.value.messages.single().blocks.single().text)
    }
}
