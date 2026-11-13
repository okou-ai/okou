package ai.okou.android.chat

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.HISTORY_RUN
import ai.okou.android.historyEventWire
import org.junit.Assert.*
import org.junit.Test

class HistoryProjectionTest {
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
        assertTrue(confirmed.messages.flatMap { it.blocks }.any { it.text == "Stopped by user" })

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
