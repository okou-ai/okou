package ai.okou.android.chat

import ai.okou.android.CHAT_IN_PROJECT
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
    fun arrivalOrderAndTransportRecoveryMatchWebWithoutFreezingTheBlock() {
        val owner = Owner()
        owner.model.receive(owner.target, delta(2, "no prefix"))
        assertTrue(owner.model.state.value.messages.isEmpty())
        owner.model.receive(owner.target, delta(0, "A"))
        owner.model.receive(owner.target, delta(2, "C"))
        owner.model.receive(owner.target, delta(1, "B"))
        owner.model.transport(RealtimePhase.Unavailable)
        assertEquals(RunOutputPhase.CatchingUp, owner.model.state.value.phase)
        assertTrue(owner.reads > 0)
        owner.model.transport(RealtimePhase.Connected)
        owner.model.receive(owner.target, delta(3, "D"))
        assertEquals("ACBD", owner.model.state.value.messages.single().blocks.single().text)
        assertEquals(RunOutputPhase.Live, owner.model.state.value.phase)
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
        assertEquals("prefix", owner.model.state.value.messages.single().blocks.single().text)
    }

    @Test
    fun cachedRunAcceptsLongUnicodeOutputWhileQueuedInputHasNoRunToSubscribe() {
        val owner = Owner()
        owner.current = owner.current.copy(source = ChatListSource.Cache)
        owner.model.reconcile()
        assertEquals(HISTORY_RUN, owner.target.runId)
        val text = "含中文 🐈".repeat(50_000)
        owner.model.receive(owner.target, delta(0, text))
        owner.model.receive(owner.target, delta(1, " complete"))
        assertEquals(
            text + " complete",
            owner.model.state.value.messages.single().blocks.single().text,
        )
        val queued = Owner()
        queued.current =
            queued.current.copy(
                transcript = HistoryTranscript(emptyList(), HistoryExecution.Queued, 0)
            )
        queued.model.reconcile()
        assertNull(queued.model.target.value)
        queued.model.close()
        owner.model.close()
        assertTrue(owner.model.state.value.messages.isEmpty())
    }

    @Test
    fun eventIdIdentifiesBlocksLikeWebAndAllBlocksSurviveUntilPersistenceOrRevocation() {
        val owner = Owner()
        owner.model.receive(owner.target, delta(0, "first"))
        val changedIdentity = delta(1).value.copy(runEventId = "different")
        owner.model.receive(
            owner.target,
            RunOutputSignal.Delta(changedIdentity.copy(delta = " next")),
        )
        assertEquals("first next", owner.model.state.value.messages.single().blocks.single().text)
        owner.model.receive(
            owner.target,
            RunOutputSignal.Delta(delta(0).value.copy(eventId = "other-event")),
        )
        assertEquals(2, owner.model.state.value.messages.size)
        repeat(40) { owner.model.receive(owner.target, delta(0, "next", "id-$it")) }
        assertEquals(42, owner.model.state.value.messages.size)
        assertEquals(RunOutputPhase.Live, owner.model.state.value.phase)
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
    fun outputStaysWithItsRunBeforeLaterInputsAndPersistenceSettlesOnlyTheMatchingBlock() {
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
        owner.model.receive(owner.target, delta(0, "new message", "next-event"))
        owner.current =
            owner.current.copy(
                transcript = owner.current.transcript!!.copy(persistedIds = setOf(eventId))
            )
        owner.model.reconcile()
        assertEquals("new message", owner.model.state.value.messages.single().blocks.single().text)
    }

    @Test
    fun replacingTheVisibleThreadRetainsItsOutputAndOldRunTargetsStayRetired() {
        val owner = Owner()
        val firstState = owner.current
        val old = owner.target
        owner.model.receive(old, delta(0, "retained"))
        owner.current =
            owner.current.copy(
                thread = firstState.thread!!.copy(id = CHAT_IN_PROJECT),
                generation = 1,
            )
        owner.model.reconcile()
        assertTrue(owner.model.state.value.messages.isEmpty())
        owner.model.receive(old, delta(1, "late"))
        owner.current = firstState.copy(generation = 2)
        owner.model.reconcile()
        assertNotEquals(old, owner.target)
        owner.model.receive(owner.target, delta(1, " after return"))
        assertEquals(
            "retained after return",
            owner.model.state.value.messages.single().blocks.single().text,
        )
        val otherRun = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val previous = owner.target
        owner.current =
            owner.current.copy(
                transcript =
                    owner.current.transcript!!.copy(
                        activeRunId = otherRun,
                        liveRunIds = listOf(HISTORY_RUN, otherRun),
                    )
            )
        owner.model.reconcile()
        owner.current =
            owner.current.copy(
                transcript =
                    owner.current.transcript!!.copy(
                        activeRunId = HISTORY_RUN,
                        liveRunIds = listOf(HISTORY_RUN),
                    )
            )
        owner.model.reconcile()
        assertNotEquals(previous, owner.target)
        owner.model.receive(previous, delta(2, "obsolete run visit"))
        assertEquals(
            "retained after return",
            owner.model.state.value.messages.single().blocks.single().text,
        )
        owner.model.close()
        assertTrue(owner.model.state.value.messages.isEmpty())
    }

    @Test
    fun retainedOutputParticipatesInRunDemandUntilTheCanonicalTerminalArrives() {
        val owner = Owner()
        owner.model.receive(owner.target, delta(0, "prefix"))
        owner.current =
            owner.current.copy(
                transcript = HistoryTranscript(emptyList(), HistoryExecution.Idle, 0),
                source = ChatListSource.Cache,
            )
        owner.model.reconcile()
        assertEquals(HISTORY_RUN, owner.target.runId)
        assertEquals(listOf(HISTORY_RUN), owner.current.controlRunIds(owner.model.state.value))
        owner.model.receive(owner.target, delta(1, " continuation"))
        assertEquals(
            "prefix continuation",
            owner.model.state.value.messages.single().blocks.single().text,
        )
        owner.persisted(
            HistoryEvent.decode(
                historyEventWire("terminal", 1, type = "run.completed", payload = "null")
            )
        )
        assertNull(owner.model.target.value)
        assertTrue(owner.current.controlRunIds(owner.model.state.value).isEmpty())
        assertEquals(
            "prefix continuation",
            owner.model.state.value.messages.single().blocks.single().text,
        )
    }
}
