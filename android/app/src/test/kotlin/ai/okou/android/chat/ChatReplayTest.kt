package ai.okou.android.chat

import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
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

    private fun event(seq: Long, kind: String, extra: String = "", thread: String = CHAT_PERSONAL) =
        chatEventWire(
            id = "00000000-0000-4000-8000-${seq.toString().padStart(12, '0')}",
            seq = seq,
            kind = kind,
            extra = extra,
            thread = thread,
        )

    @Test
    fun metadataTouchesPreserveActivityAndUnrelatedModelSettings() {
        val row =
            replay(
                    event(
                        1,
                        "created",
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

        assertEquals(true, row.muted)
        assertEquals("2026-11-13T00:00:00.000Z", row.sortAt)
        assertEquals(setOf("codex/test", "claude-code/test"), row.modelSettings?.keys)
        assertEquals("HIGH", row.modelSettings?.get("codex/test")?.effort?.name)
    }

    @Test
    fun projectEventsClearMembership() {
        val row =
            replay(
                    event(1, "created", extra = ",\"projectId\":\"$CHAT_PROJECT\""),
                    event(4, "project_updated", extra = ",\"projectId\":null"),
                )
                .single()
        assertNull(row.projectId)
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
        val state = ChatListUiState(threads = rows)
        assertEquals(
            listOf(CHAT_PERSONAL),
            chatListGroups(state).flatMap { it.threads }.map { it.id },
        )
        assertEquals(true, rows.first().hidden)
    }

    @Test
    fun projectGroupsIncludeArchivedUnreadAndExcludeMutedChats() {
        val projectRow =
            replay(
                    event(1, "created", extra = ",\"projectId\":\"$CHAT_PROJECT\""),
                    event(2, "archived"),
                    event(3, "sort_touched", extra = ",\"muted\":false"),
                )
                .single()
        val outside = projectRow.copy(id = "99999999-9999-4999-8999-999999999999", projectId = null)
        val state =
            ChatListUiState(
                threads = listOf(projectRow, outside),
                projectList =
                    ProjectListUiState(
                        rows =
                            listOf(
                                ConfirmedProject(
                                    CHAT_PROJECT,
                                    "Research",
                                    "2026-11-13T00:00:00Z",
                                    "2026-11-13T00:00:00Z",
                                )
                            )
                    ),
                indicators =
                    Indicators(
                        mapOf(projectRow.id to IndicatorsThreadsValue.UNREAD),
                        mapOf(projectRow.id to "2026-11-13T00:00:00Z"),
                    ),
                filter = ChatListFilter.Unread,
            )
        assertEquals(projectRow.id, chatListGroups(state).first().threads.single().id)
        assertTrue(chatListGroups(state).last().threads.isEmpty())
        assertTrue(
            chatListGroups(state.copy(threads = listOf(projectRow.copy(muted = true)))).all {
                it.threads.isEmpty()
            }
        )
        val active =
            checkNotNull(state.indicators)
                .copy(threads = mapOf(projectRow.id to IndicatorsThreadsValue.ACTIVE))
        assertEquals(
            projectRow,
            chatListGroups(state.copy(indicators = active)).first().threads.single(),
        )
        val read = state.copy(indicators = active.copy(unreadAt = emptyMap()))
        assertTrue(chatListGroups(read).all { it.threads.isEmpty() })
    }

    @Test
    fun pinBoundaryDependsOnTheRowsVisibleWithinEachGroup() {
        val ordinary = "99999999-9999-4999-8999-999999999999"
        val project =
            ConfirmedProject(
                CHAT_PROJECT,
                "Research",
                "2026-11-13T00:00:00Z",
                "2026-11-13T00:00:00Z",
            )
        val projectMember = ",\"projectId\":\"$CHAT_PROJECT\""
        val state =
            ChatListUiState(
                threads =
                    replay(
                        event(1, "created", thread = CHAT_IN_PROJECT, extra = projectMember),
                        event(2, "created", thread = ordinary, extra = projectMember),
                        event(3, "created"),
                        event(4, "pinned", thread = CHAT_IN_PROJECT, extra = ",\"pinOrder\":\"a1\""),
                    ),
                projectList = ProjectListUiState(rows = listOf(project)),
                indicators =
                    Indicators(
                        mapOf(CHAT_IN_PROJECT to IndicatorsThreadsValue.UNREAD),
                        mapOf(CHAT_IN_PROJECT to "2026-11-13T00:00:00Z"),
                    ),
            )
        val (projectGroup, outsideGroup) = chatListGroups(state)
        assertEquals(listOf(CHAT_IN_PROJECT, ordinary), projectGroup.threads.map { it.id })
        assertEquals(0, projectGroup.pinnedTailIndex())
        assertEquals(-1, outsideGroup.pinnedTailIndex())

        val unreadProject = chatListGroups(state.copy(filter = ChatListFilter.Unread)).first()
        assertEquals(listOf(CHAT_IN_PROJECT), unreadProject.threads.map { it.id })
        assertEquals(-1, unreadProject.pinnedTailIndex())
        assertEquals(0, unreadProject.pinnedTailIndex(hasProvisional = true))
    }

    @Test
    fun pinRankKeysMatchTheCanonicalBase62Ordering() {
        val legacy = replay(event(1, "created"), event(2, "pinned")).single()
        val smallest = "A" + "0".repeat(26)
        assertEquals("a0", ChatPinOrder.first(emptyList()))
        assertEquals("a0", ChatPinOrder.first(listOf(legacy)))
        for ((upper, expected) in
            listOf(
                "a1" to "a0",
                "a0" to "Zz",
                "Z0" to "Yzz",
                "b00" to "az",
                "a0V" to "a0",
                smallest.dropLast(1) + "1" to smallest + "V",
                smallest + "V" to smallest + "G",
                smallest + "01" to smallest + "00V",
            )) {
            assertEquals(upper, expected, ChatPinOrder.first(listOf(legacy.copy(pinOrder = upper))))
        }

        val moved = legacy.copy(id = "moved", pinOrder = "d0000")
        for ((lower, upper, expected) in
            listOf(
                Triple("a0", "a1", "a0V"),
                Triple("a0V", "a1", "a0l"),
                Triple("Zz", "a0", "ZzV"),
                Triple("Zz", "a1", "a0"),
                Triple("a0", "a0V", "a0G"),
                Triple("b125", "b129", "b127"),
            )) {
            val left = legacy.copy(id = "left", pinOrder = lower)
            val right = legacy.copy(id = "right", pinOrder = upper)
            val updates =
                ChatPinOrder.move(listOf(left, right, moved), moved.id, right.id, before = true)
            assertEquals(listOf(ChatPinOrderUpdate(moved.id, expected)), updates)
        }
        val pins = listOf(legacy, moved)
        assertEquals(
            listOf(ChatPinOrderUpdate(moved.id, "a0")),
            ChatPinOrder.move(pins, moved.id, legacy.id, before = true),
        )
    }

    @Test
    fun rankingIncludesHiddenAndArchivedPeersButDoesNotCrossListGroups() {
        val outside = replay(event(1, "created"), event(2, "pinned")).single()
        val otherOutside = outside.copy(id = "other-outside")
        val member = outside.copy(id = CHAT_IN_PROJECT, projectId = CHAT_PROJECT)
        val unresolved = member.copy(id = "unresolved", projectId = "missing")
        val hidden = member.copy(id = "hidden", hidden = true)
        val archived = member.copy(id = "archived", archived = true)
        val project =
            ConfirmedProject(CHAT_PROJECT, "Research", outside.createdAt, outside.createdAt)
        val state =
            ChatListUiState(
                threads = listOf(outside, otherOutside, member, hidden, archived, unresolved),
                listPhase = ChatReadPhase.Ready,
                source = ChatListSource.Network,
                projectList =
                    ProjectListUiState(rows = listOf(project), source = ChatListSource.Network),
            )
        val (projectGroup, unresolvedGroup, outsideGroup) = chatListGroups(state)
        assertEquals(listOf(member), projectGroup.threads)
        assertEquals(listOf(member, hidden, archived), projectGroup.rankScope(state))
        assertEquals(listOf(outside, otherOutside), outsideGroup.threads)
        assertEquals(listOf(outside, otherOutside), outsideGroup.rankScope(state))
        assertEquals(listOf(unresolved), unresolvedGroup.threads)
        assertTrue(ChatRowAction.Unpin in state.rowActions(unresolved, unresolvedGroup, 0))
        val unpinned = unresolved.copy(pinnedAt = null)
        assertFalse(ChatRowAction.Pin in state.rowActions(unpinned, unresolvedGroup, 0))
        val actions = state.rowActions(member, projectGroup, 0)
        assertTrue(ChatRowAction.Unpin in actions)
        assertFalse(ChatRowAction.MovePinUp in actions)
        assertFalse(ChatRowAction.MovePinDown in actions)
        val visible = projectGroup.copy(threads = listOf(member, hidden.copy(hidden = false)))
        assertTrue(ChatRowAction.MovePinDown in state.rowActions(member, visible, 0))
        assertFalse(
            ChatRowAction.MovePinDown in
                state.copy(filter = ChatListFilter.Muted).rowActions(member, visible, 0)
        )
    }

    @Test
    fun mutedChatsSuppressActivityAndCollapsedProjectsPreferVisibleUnread() {
        val rows =
            replay(
                event(1, "created"),
                event(2, "created", thread = CHAT_IN_PROJECT),
                event(3, "sort_touched", extra = ",\"muted\":true"),
            )
        val running = rows.single { it.id == CHAT_PERSONAL }
        val unread = rows.single { it.id == CHAT_IN_PROJECT }
        val indicators =
            mapOf(
                running.id to IndicatorsThreadsValue.ACTIVE,
                unread.id to IndicatorsThreadsValue.UNREAD,
            )
        val unreadIds = setOf(running.id, unread.id)
        assertEquals(
            ChatRowStatus.Muted,
            chatRowStatus(indicators[running.id], running.muted == true, unread = false),
        )
        assertEquals(
            ChatRowStatus.Muted,
            chatRowStatus(indicators[unread.id], muted = true, unread = true),
        )
        assertEquals(
            ProjectActivity(unread = 1, running = 0),
            collapsedProjectActivity(listOf(running, unread), indicators, unreadIds),
        )
        assertEquals(
            ProjectActivity(unread = 1, running = 1),
            collapsedProjectActivity(
                listOf(running.copy(muted = false), unread.copy(muted = true)),
                indicators,
                unreadIds,
            ),
        )
        assertEquals(
            ProjectActivity(unread = 0, running = 0),
            collapsedProjectActivity(
                listOf(running, unread.copy(muted = true)),
                indicators,
                unreadIds,
            ),
        )
    }

    @Test
    fun waveCountsIdleRowsAndProjectHeadersButSkipsFoldedChildren() {
        val member = ",\"projectId\":\"$CHAT_PROJECT\""
        val threads =
            replay(
                event(1, "created"),
                event(2, "created", extra = member, thread = CHAT_IN_PROJECT),
                event(3, "created", extra = member, thread = "99999999-9999-4999-8999-999999999999"),
            )
        val project =
            ConfirmedProject(
                CHAT_PROJECT,
                "Research",
                "2026-11-13T00:00:00Z",
                "2026-11-13T00:00:00Z",
            )
        val groups =
            chatListGroups(
                ChatListUiState(
                    threads = threads,
                    projectList = ProjectListUiState(rows = listOf(project)),
                )
            )
        val indicators = mapOf(CHAT_IN_PROJECT to IndicatorsThreadsValue.ACTIVE)
        val provisional =
            mapOf<String?, List<ProvisionalChat>>(
                project.id to listOf(ProvisionalChat("pending", project.id))
            )

        val (open, afterOpen) =
            chatListSections(groups, setOf(project.id), indicators, emptySet(), provisional)
        assertEquals(0, open.firstRow)
        assertEquals(1, open.firstChatRow)
        assertEquals(4, afterOpen.firstChatRow)

        val (folded, afterFolded) =
            chatListSections(groups, emptySet(), indicators, emptySet(), provisional)
        assertEquals(ChatRowStatus.Running, folded.foldedStatus)
        assertEquals(1, afterFolded.firstChatRow)
    }

    @Test
    fun waveRowsTrailByTwoHundredMillisecondsAndWrapEveryTwelveRows() {
        val time = 1_100_000_000L
        assertEquals(runningWavePhase(time, 0), runningWavePhase(time + 200_000_000L, 1), 0f)
        assertEquals(runningWavePhase(time, 0), runningWavePhase(time, 12), 0f)
        assertEquals(runningWavePhase(time, 0), runningWavePhase(time + 2_400_000_000L, 0), 0f)
        assertEquals(11f / 12f, runningWavePhase(0, 1), 0.00001f)
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
}
