package ai.okou.android.chat

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.HISTORY_RUN
import ai.okou.android.RecoveryApiFixture
import ai.okou.android.historyEventWire
import org.junit.Assert.*
import org.junit.Test

class HistoryProjectionTest {
    @Test
    fun runFailureReasonsIncludingFutureTokensSurviveHistory() {
        for (reason in
            listOf(
                "provider_request_timeout",
                "provider_bad_request",
                "account_verification_required",
                "provider_model_restricted",
                "guest_memory_oom_killed",
                "future_reason",
            )) {
            val row = HistoryEvent.decode(RecoveryApiFixture.failure(reason))
            val message = transcript(row).messages.single()
            assertEquals(reason, message.failureReason)
        }
    }

    @Test
    fun oomAndRequestTimeoutRetryWithoutInventingAccountOrResetHints() {
        for (reason in listOf("guest_memory_oom_killed", "provider_request_timeout")) {
            val failure = AssistantFailure.Run("failed", reason)
            val recovery = classifyFailure(failure, RecoveryFramework.Codex)
            assertEquals(FailureKind.Retryable, recovery.kind)
            assertTrue(recovery.canContinue)
            assertNull(recovery.framework)
            assertNull(recovery.limit)
        }
    }

    @Test
    fun runFailuresIgnoreRetainedDiagnosticsWhileOutputErrorsRemainVisible() {
        for (payload in
            listOf("null", """{"content":"private diagnostic","error":"private diagnostic"}""")) {
            val decoded = event("failed", 1, "run.failed", payload = payload)
            assertNull(decoded.inputError)
            assertNull(decoded.outputError)
            val failed = transcript(decoded)
            assertEquals(HistoryExecution.Failed, failed.execution)
            assertEquals("run.failed", failed.messages.single().status)
            assertFalse(
                failed.messages.flatMap { it.blocks }.any { it.text.contains("private diagnostic") }
            )
        }
        val output =
            transcript(
                event(
                    "output",
                    1,
                    "output.error",
                    payload = """{"error":"Ordinary output error"}""",
                )
            )
        assertTrue(output.messages.flatMap { it.blocks }.any { it.text == "Ordinary output error" })
    }

    @Test
    fun activeOutputTargetUsesNewestLiveRunLikeWeb() {
        val nextRun = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val old = input("older", 1)
        val next = input("newer", 2, nextRun)
        val lateOld = event("older-late", 3, "output.message")
        assertEquals(nextRun, transcript(old, next, lateOld).activeRunId)
        val terminal = event("newer-terminal", 4, "run.completed", nextRun)
        val stillLate = event("still-older-late", 5, "output.message")
        assertEquals(HISTORY_RUN, transcript(old, next, lateOld, terminal, stillLate).activeRunId)
        assertNull(
            transcript(old, next, terminal, event("older-terminal", 5, "run.completed")).activeRunId
        )
        assertEquals(
            nextRun,
            transcript(old, event("new-output", 2, "output.message", nextRun)).activeRunId,
        )
        assertNull(transcript(input("queued", 1, null)).activeRunId)
    }

    private fun event(
        id: String,
        seq: Long,
        type: String,
        run: String? = HISTORY_RUN,
        payload: String = "null",
        revoke: String? = null,
    ) =
        HistoryEvent.decode(
            historyEventWire(id, seq, type = type, run = run, payload = payload, revoke = revoke)
        )

    private fun input(id: String, seq: Long, run: String? = HISTORY_RUN) =
        event(
            id,
            seq,
            "input.prompt",
            run,
            """{"userMessage":{"version":1,"parts":[{"type":"text","text":"$id"}]}}""",
        )

    private fun transcript(vararg rows: HistoryEvent) =
        projectHistory(
            HistoryCheckpoint(
                CHAT_PERSONAL,
                rows.toList(),
                HistoryCursor(rows.last().id, rows.last().seqId),
            )
        )

    @Test
    fun anInterruptStopsTheRunAndTheTerminalDoesNotDuplicateItsOutcome() {
        val prompt = input("prompt", 1)
        val partial =
            event("partial", 2, "output.message", payload = """{"content":"Partial reply"}""")
        val interrupt = event("interrupt", 3, "control.interrupt")
        val stopped = transcript(prompt, partial, interrupt)
        assertEquals(HistoryExecution.Cancelled, stopped.execution)
        assertEquals(1, stopped.messages.count { it.status == "run.cancelled" })
        assertTrue(stopped.messages.flatMap { it.blocks }.any { it.text == "Partial reply" })

        val terminal =
            event("terminal", 4, "run.cancelled", payload = """{"error":"Stopped by user"}""")
        val confirmed = transcript(prompt, partial, interrupt, terminal)
        assertEquals(HistoryExecution.Cancelled, confirmed.execution)
        assertEquals(1, confirmed.messages.count { it.status == "run.cancelled" })

        val completed = event("completed", 3, "run.completed")
        val lateInterrupt = event("late-interrupt", 4, "control.interrupt")
        val lateStop = transcript(prompt, partial, completed, lateInterrupt)
        assertEquals(
            listOf("run.completed", "run.cancelled"),
            lateStop.messages.mapNotNull { it.status },
        )
        assertEquals(HistoryExecution.Cancelled, lateStop.execution)
    }

    @Test
    fun terminalOrderingKeepsOldActivityFromOverridingTheLatestRun() {
        val nextRun = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val old = input("older", 1)
        val next = input("newer", 2, nextRun)
        assertEquals(
            HistoryExecution.Completed,
            transcript(old, next, event("completed-newer", 3, "run.completed", nextRun)).execution,
        )
        assertEquals(
            HistoryExecution.Running,
            transcript(old, next, event("completed-older", 3, "run.completed")).execution,
        )
    }

    @Test
    fun aLateTerminalFromAnOlderRunDoesNotReplaceTheLatestTurnOutcome() {
        val nextRun = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val result =
            transcript(
                input("older", 1),
                input("newer", 2, nextRun),
                event("failed-newer", 3, "run.failed", nextRun),
                event("completed-older", 4, "run.completed"),
            )
        assertEquals("run.failed", result.messages.last().status)
        assertEquals(HistoryExecution.Failed, result.execution)
    }

    @Test
    fun pendingPromptsRemainInTheTranscriptWhileAutomationWaitsInTheQueue() {
        val waiting = input("waiting", 1, null)
        val reply = event("reply", 2, "output.message", payload = """{"content":"Earlier work"}""")
        val automation =
            event(
                "scheduled",
                3,
                "input.automation",
                null,
                """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Scheduled work"}]}}""",
            )
        val nextAutomation =
            event(
                "a-later-automation",
                4,
                "input.automation",
                null,
                """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Next scheduled work"}]}}""",
            )
        val result = transcript(waiting, reply, automation, nextAutomation)
        assertEquals(
            listOf("waiting", "reply", "scheduled", "a-later-automation"),
            result.messages.map { it.id },
        )
        assertFalse(result.messages.first().queued)
        assertTrue(result.messages.last().queued)
        assertEquals(HistoryExecution.Running, result.execution)
        assertEquals(HistoryExecution.Queued, transcript(waiting).execution)
    }

    @Test
    fun queuedAutomationWithoutAUserDocumentKeepsItsActionTarget() {
        val queued = event("automation", 1, "input.automation", run = null)
        val pending = transcript(queued)
        assertEquals(listOf(queued.id), pending.queuedEventIds)
        val message = pending.messages.single()
        assertEquals(queued.id, message.id)
        assertTrue(message.queued)
        assertTrue(message.blocks.isEmpty())

        val delivered = event("delivered", 2, "input.automation", revoke = queued.id)
        val consumed = transcript(queued, delivered)
        assertTrue(consumed.queuedEventIds.isEmpty())
        assertTrue(consumed.messages.isEmpty())
    }

    @Test
    fun internalInputsDoNotBecomeUserTurnsAndAutomationErrorsRemainVisible() {
        val scheduled =
            """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Scheduled work"}]}}"""
        val result =
            transcript(
                input("request", 1),
                event(
                    "budget",
                    2,
                    "input.budget",
                    payload =
                        """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Internal time budget"}]}}""",
                ),
                event("reply", 3, "output.message", payload = """{"content":"Result"}"""),
                event("completed", 4, "run.completed"),
                event("automation", 5, "input.automation", null, scheduled),
                event(
                    "automation-rejected",
                    6,
                    "input.rejected",
                    null,
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Scheduled work"}]},"error":"Automation unavailable"}""",
                    revoke = "automation",
                ),
                event(
                    "automation-error",
                    7,
                    "output.error",
                    null,
                    """{"error":"Automation unavailable"}""",
                ),
            )
        assertEquals(
            listOf("request", "reply", "completed", "automation-error"),
            result.messages.map { it.id },
        )
        assertEquals("Automation unavailable", result.messages.last().blocks.single().text)
    }
}
