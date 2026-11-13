package ai.okou.android.chat

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_OTHER_AGENT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.api.generated.AgentsItem
import ai.okou.android.api.generated.AgentsItemVisibility
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.IndicatorsThreadsValue
import ai.okou.android.chatEventWire
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class ChatReplayTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun replay(vararg events: String): List<ConfirmedChat> {
        val page =
            json.decodeFromString<ChatEvents>(
                """{"events":[${events.joinToString(",")}],"hasMore":false}"""
            )
        return replayChats(
            ChatCheckpoint(
                ChatArchive(emptyList()),
                ChatCursor(),
                page.events,
                page.events.last().cursor(),
            )
        )
    }

    private fun event(
        seq: Long,
        kind: String,
        extra: String = "",
        agent: String = CHAT_AGENT,
        thread: String = CHAT_PERSONAL,
    ) =
        chatEventWire(
            id = "00000000-0000-4000-8000-${seq.toString().padStart(12, '0')}",
            seq = seq,
            kind = kind,
            extra = extra,
            agent = agent,
            thread = thread,
        )

    @Test
    fun metadataTouchesPreserveOriginalAgentActivityAndUnrelatedModelSettings() {
        val row =
            replay(
                    event(
                        1,
                        "created",
                        agent = CHAT_OTHER_AGENT,
                        extra = ",\"modelSettings\":{\"codex/test\":{\"effort\":\"high\"}}",
                    ),
                    event(3, "sort_touched", extra = ",\"muted\":true")
                        .replace("00:00:00.000Z", "00:01:00.000Z"),
                    event(
                        8,
                        "model_selection_updated",
                        extra =
                            ",\"modelSettingsPatch\":{\"model\":\"claude-code/test\",\"effort\":\"extra\"}",
                    ),
                    event(12, "sort_touched"),
                )
                .single()
        assertEquals(CHAT_OTHER_AGENT, row.agentId)
        assertEquals(true, row.muted)
        assertEquals("2026-11-13T00:00:00.000Z", row.sortAt)
        assertEquals(setOf("codex/test", "claude-code/test"), row.modelSettings?.keys)
        assertEquals("HIGH", row.modelSettings?.get("codex/test")?.effort?.name)
    }

    @Test
    fun projectEventsClearMembershipAndOnlyExplicitReassignmentChangesAgent() {
        val row =
            replay(
                    event(
                        1,
                        "created",
                        extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                        agent = CHAT_OTHER_AGENT,
                    ),
                    event(4, "project_updated", extra = ",\"projectId\":null"),
                    event(9, "sort_touched", extra = ",\"reassignedAgentId\":\"$CHAT_AGENT\""),
                )
                .single()
        assertNull(row.projectId)
        assertEquals(CHAT_AGENT, row.agentId)
    }

    @Test
    fun explicitPinRanksOverrideRecencyAndHiddenRowsRemainInConfirmedStateOnly() {
        val other = "99999999-9999-4999-8999-999999999999"
        val rows =
            replay(
                event(1, "created"),
                event(2, "created", thread = other),
                event(3, "pinned", extra = ",\"pinOrder\":\"a2\""),
                event(4, "pinned", extra = ",\"pinOrder\":\"a1\"", thread = other),
                event(8, "sort_touched", extra = ",\"hidden\":true", thread = other),
            )
        assertEquals(listOf(other, CHAT_PERSONAL), rows.map { it.id })
        val state = ChatListUiState(threads = rows, agents = agents())
        assertEquals(
            listOf(CHAT_PERSONAL),
            chatListGroups(state).flatMap { it.threads }.map { it.id },
        )
        assertEquals(true, rows.first().hidden)
    }

    @Test
    fun projectGroupsSpanOriginalAgentsAndUnreadIncludesArchivedButExcludesMuted() {
        val projectRow =
            replay(
                    event(
                        1,
                        "created",
                        extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                        agent = CHAT_OTHER_AGENT,
                    ),
                    event(2, "archived"),
                    event(3, "sort_touched", extra = ",\"muted\":false"),
                )
                .single()
        val outside = projectRow.copy(id = "99999999-9999-4999-8999-999999999999", projectId = null)
        val state =
            ChatListUiState(
                threads = listOf(projectRow, outside),
                agents = agents(),
                projectsEnabled = true,
                projects =
                    listOf(
                        ConfirmedProject(
                            CHAT_PROJECT,
                            "Research",
                            "2026-11-13T00:00:00Z",
                            "2026-11-13T00:00:00Z",
                        )
                    ),
                indicators =
                    Indicators(
                        emptyMap(),
                        mapOf(projectRow.id to IndicatorsThreadsValue.UNREAD),
                        emptyMap(),
                    ),
                filter = ChatListFilter.Unread,
            )
        assertEquals(CHAT_OTHER_AGENT, chatListGroups(state).first().threads.single().agentId)
        assertTrue(chatListGroups(state).last().threads.isEmpty())
        assertTrue(
            chatListGroups(state.copy(threads = listOf(projectRow.copy(muted = true)))).all {
                it.threads.isEmpty()
            }
        )
        assertTrue(
            chatListGroups(
                    state.copy(
                        indicators =
                            state.indicators?.copy(
                                threads = mapOf(projectRow.id to IndicatorsThreadsValue.ACTIVE)
                            )
                    )
                )
                .all { it.threads.isEmpty() }
        )
    }

    @Test
    fun sqlAndOffsetTimesUseUtcAndMillisecondPrecisionForHistoricalPins() {
        assertEquals(chatTime("2026-11-13T00:00:00.123Z"), chatTime("2026-11-13 00:00:00.123456"))
        assertEquals(chatTime("2026-11-13T00:00:00Z"), chatTime("2026-11-13T08:00:00+0800"))
        val older =
            event(1, "created", thread = "99999999-9999-4999-8999-999999999999")
                .replace("00:00:00.000Z", "00:00:00.000001Z")
        val newer = event(2, "created").replace("00:00:00.000Z", "00:00:00.000002Z")
        assertEquals(CHAT_PERSONAL, replay(older, newer).first().id)
    }

    private fun agents() =
        listOf(
            AgentsItem(
                CHAT_AGENT,
                true,
                "user-a",
                null,
                "My Okou",
                null,
                null,
                AgentsItemVisibility.PRIVATE,
            )
        )
}
