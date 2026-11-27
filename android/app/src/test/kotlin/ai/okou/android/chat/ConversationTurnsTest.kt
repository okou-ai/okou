package ai.okou.android.chat

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.HISTORY_RUN
import ai.okou.android.historyEventWire
import androidx.compose.ui.text.TextRange
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationTurnsTest {
    @Test
    fun feedbackWithoutReplyOwnsOneHeaderInItsDisplayTurn() {
        val input = row(1, "input.prompt")
        val reply = row(2)
        val steer = row(3, "input.prompt")
        val legacy = row(4, "output.error", payload = """{"error":"Could not continue"}""")
        val failed = row(5, "run.failed")
        val stopped = row(6, "run.cancelled")
        fun headers(vararg rows: HistoryEvent) =
            content(*rows).messages.filter { it.showFeedbackHeader }.map { it.message.id }

        assertEquals(listOf(failed.id), headers(input, failed))
        assertEquals(listOf(stopped.id), headers(input, reply, steer, stopped))
        assertEquals(listOf(failed.id), headers(input, legacy, failed))
        assertEquals(emptyList<String>(), headers(input, reply, legacy, failed))
        assertEquals(emptyList<String>(), headers(input, reply, stopped))
    }

    @Test
    fun structuredFailureReplacesLegacyFeedbackInPlaceWithinItsTurn() {
        val input = row(1, "input.prompt")
        val legacy = row(2, "output.error", payload = """{"error":"Could not continue"}""")
        val failure = row(3, "run.failed")
        val laterLegacy = row(4, "output.error", payload = """{"error":"Could not continue"}""")
        val firstCard = content(input, legacy).messages.last()
        val upgraded = content(input, legacy, failure).messages.last()
        assertEquals(legacy.id, firstCard.key)
        assertEquals(firstCard.key, upgraded.key)
        assertEquals(failure.id, upgraded.message.id)
        assertTrue(upgraded.includes(legacy.id))
        assertTrue(upgraded.includes(failure.id))
        assertEquals(
            listOf(input.id, failure.id),
            content(input, legacy, failure).messages.map { it.message.id },
        )

        val structuredFirst = content(input, failure, laterLegacy).messages.last()
        assertEquals(failure.id, structuredFirst.key)
        assertEquals(failure.id, structuredFirst.message.id)
        assertTrue(structuredFirst.includes(laterLegacy.id))

        val steer = row(5, "input.prompt")
        val nextError = row(6, "output.error", payload = """{"error":"New failure"}""")
        assertEquals(
            listOf(input.id, failure.id, steer.id, nextError.id),
            content(input, failure, laterLegacy, steer, nextError).messages.map { it.message.id },
        )
    }

    @Test
    fun aDeliveredSteerEndsThePreviousSummaryAndStartsItsOwnTurn() {
        val queued = row(1, "input.prompt", run = null, time = "10:00:00")
        val delivered = row(2, "input.prompt", time = "10:01:00", revoke = queued.id)
        val first = row(3, time = "10:01:20")
        val second = row(4, time = "10:01:30")
        val steer = row(5, "input.prompt", time = "10:01:46")
        val firstTurn = content(queued, delivered, first, second, steer)
        assertEquals(
            listOf(delivered.id, second.id, steer.id),
            firstTurn.messages.map { it.message.id },
        )
        val earlier = firstTurn.messages[1]
        assertEquals(first.id, earlier.key)
        assertEquals(listOf(first.id), earlier.earlier.map { it.id })
        assertEquals(ReplyPhase.Continued, earlier.summary?.phase)
        assertEquals(46_000L, earlier.summary?.elapsedMillis(0L))
        assertNull(firstTurn.messages.last().summary)

        val nextReply = row(6, time = "10:02:00")
        val current = content(queued, delivered, first, second, steer, nextReply)
        assertEquals(first.id, current.messages[1].key)
        assertEquals(ReplyPhase.Replying, current.messages.last().summary?.phase)
        assertTrue(current.messages.last().earlier.isEmpty())
    }

    @Test
    fun lateSuggestionsUpdateOnlyTheLatestCompletedTurn() {
        val input = row(1, "input.prompt", time = "10:00:00")
        val reply = row(2, time = "10:00:25")
        val completed = row(3, "run.completed", time = "10:00:46")
        val before = checkNotNull(content(input, reply, completed).completion)
        assertEquals(completed.id, before.eventId)
        assertEquals(reply.id, before.anchorKey)
        assertTrue(before.followups.isEmpty())
        assertEquals(
            46_000L,
            content(input, reply, completed).messages.last().summary?.elapsedMillis(0),
        )

        val suggestions =
            row(
                4,
                "output.followups",
                payload =
                    """{"content":${JsonPrimitive(
                """{"version":1,"followups":[
                    {"kind":"talk","prompt":"Make a checklist"},
                    {"kind":"generate","generationType":"video","prompt":"Make a video"},
                    {"kind":"generate","generationType":"presentation","prompt":"Write a brief"},
                    {"kind":"workflow","prompt":"Create a workflow"},
                    {"kind":"email","prompt":"Draft an email"}]}""",
            )}}""",
            )
        val after = checkNotNull(content(input, reply, completed, suggestions).completion)
        assertEquals(before.finishedAtMillis, after.finishedAtMillis)
        assertEquals(
            listOf("Make a checklist", "Write a brief", "Create a workflow"),
            after.followups.map { it.prompt },
        )

        val newRun = row(4, "input.prompt", run = "second-run", time = "10:01:00")
        val late = row(5, "output.followups", payload = """{"content":"invalid"}""")
        assertNull(content(input, reply, completed, newRun, late).completion)
        assertEquals(
            newRun.id,
            content(input, reply, completed, newRun, late).messages.last().message.id,
        )
        val pending = row(4, "input.prompt", run = null)
        assertNull(content(input, reply, completed, pending).completion)
        val rejected =
            row(
                4,
                "input.rejected",
                run = null,
                payload =
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Rejected"}]}}""",
            )
        val olderCompletion = content(input, reply, completed, rejected).completion
        assertEquals(reply.id, olderCompletion?.anchorKey)
    }

    @Test
    fun aConfirmedStreamingReplyDoesNotAddAnotherStep() {
        val input = row(1, "input.prompt")
        val first = row(2)
        val second = row(3)
        val preview =
            HistoryMessage(
                second.id,
                HISTORY_RUN,
                HistoryRole.Assistant,
                listOf(HistoryBlock(HistoryBlockKind.Text, "Typing")),
            )
        val stream = RunOutputState(CHAT_PERSONAL, listOf(preview), RunOutputPhase.Live)
        val streaming = content(input, first, output = stream).messages.last()
        val confirmed = content(input, first, second, output = stream).messages.last()
        assertEquals(listOf(first.id), confirmed.earlier.map { it.id })
        assertEquals(streaming.key, confirmed.key)
        assertEquals(streaming.message.id, confirmed.message.id)
        val stopped = row(4, "run.cancelled")
        val stopping = content(input, first, stopped, output = stream).messages
        assertEquals(listOf(input.id, second.id, stopped.id), stopping.map { it.message.id })
        assertEquals(ReplyPhase.Stopped, stopping[1].summary?.phase)
    }

    @Test
    fun aReplyWithoutARunHasNoWorkSummary() {
        val input = row(1, "input.prompt")
        val reply = row(2)
        val completed = row(3, "run.completed")
        val delivery = row(4, run = null)
        val turns = content(input, reply, completed, delivery)

        assertEquals(listOf(input.id, reply.id, delivery.id), turns.messages.map { it.message.id })
        assertEquals(ReplyPhase.Completed, turns.messages[1].summary?.phase)
        assertNull(turns.messages.last().summary)
        assertNull(turns.completion)
    }

    @Test
    fun earlierArtifactsFollowTheLatestReplyOnlyOnce() {
        val checklist = "/artifacts/aaaaaaaaaa.md"
        val notes = "/artifacts/bbbbbbbbbb.md"
        fun message(id: String, body: String) =
            HistoryMessage(
                id,
                HISTORY_RUN,
                HistoryRole.Assistant,
                listOf(HistoryBlock(HistoryBlockKind.Text, body)),
            )
        val first = message("first", "[Checklist]($checklist) and [Notes]($notes)")
        val second = message("second", "[Notes again]($notes)")
        val latest = message("latest", "[Current checklist]($checklist)")
        assertEquals(
            ReplyArtifactGroup(listOf(ReplyArtifact(notes, "Notes")), followsCard = true),
            earlierReplyArtifacts(listOf(first, second))
                .afterLatestReply(latest.blocks, interactiveLinks = true),
        )
    }

    @Test
    fun workDurationCarriesSecondsAndMinutesAtRoundedBoundaries() {
        assertEquals(WorkDuration(0, 0, 46), workDuration(46_000))
        assertEquals(WorkDuration(0, 1, 0), workDuration(59_500))
        assertEquals(WorkDuration(0, 1, 24), workDuration(84_000))
        assertEquals(WorkDuration(1, 0, 0), workDuration(3_599_500))
        assertEquals(WorkDuration(2, 0, 0), workDuration(7_170_000))
        assertEquals(WorkDuration(2, 5, 0), workDuration(7_490_000))
    }

    @Test
    fun aSuggestionAppendsToTheDraftAndARepeatedTapSelectsAnExactLine() {
        val first = insertConversationFollowup("Make a checklist with timings", "Make a checklist")
        assertEquals("Make a checklist with timings\nMake a checklist", first.text)
        assertEquals(TextRange(first.text.length), first.selection)
        val second = insertConversationFollowup(first.text, "Make a checklist")
        assertEquals(first.text, second.text)
        assertEquals(TextRange(first.text.indexOf('\n') + 1, first.text.length), second.selection)
    }

    @Test
    fun aRepeatedMultilineSuggestionSelectsTheWholeDraftRange() {
        val prompt = "Make a checklist.\nInclude the deadlines."
        val existing = "Existing notes"
        val first = insertConversationFollowup(existing, prompt)
        assertEquals("$existing\n$prompt", first.text)

        val draft = "${first.text}\nKeep this too."
        val repeated = insertConversationFollowup(draft, prompt)
        assertEquals(draft, repeated.text)
        assertEquals(TextRange(existing.length + 1, first.text.length), repeated.selection)
    }

    private fun row(
        sequence: Long,
        type: String = "output.message",
        payload: String =
            when (type) {
                "input.prompt" ->
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Prompt $sequence"}]}}"""
                "output.message" -> """{"content":"Reply $sequence"}"""
                else -> "null"
            },
        run: String? = HISTORY_RUN,
        revoke: String? = null,
        time: String = "10:00:00",
    ) =
        HistoryEvent.decode(
            historyEventWire(
                "event-$sequence",
                sequence,
                type = type,
                payload = payload,
                run = run,
                revoke = revoke,
                createdAt = "2026-11-24T${time}Z",
            ),
        )

    private fun content(
        vararg rows: HistoryEvent,
        output: RunOutputState = RunOutputState(),
    ): ConversationContent {
        val last = rows.last()
        val checkpoint =
            HistoryCheckpoint(CHAT_PERSONAL, rows.toList(), HistoryCursor(last.id, last.seqId))
        return conversationContent(
            projectHistory(checkpoint),
            output,
            CHAT_PERSONAL,
            emptyList(),
            emptySet(),
        )
    }
}
