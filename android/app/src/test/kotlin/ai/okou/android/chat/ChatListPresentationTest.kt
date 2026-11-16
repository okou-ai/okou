package ai.okou.android.chat

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_EVENT
import ai.okou.android.CHAT_OTHER_AGENT
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatListApiFixture
import ai.okou.android.jsonResponse
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class ChatListPresentationTest {
    @Test
    fun archivedParentsKeepEveryVisibleChildAndEmptyGroupsWithoutChangingDailyChatFilters() =
        runTest {
            ChatListApiFixture().use { fixture ->
                val archivedProject = id(203)
                fixture.projects = {
                    jsonResponse(
                        """{"projects":[
                    {"id":"$CHAT_PROJECT","name":"Active","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"},
                    {"id":"${id(202)}","name":"Active empty","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","archivedAt":null},
                    {"id":"$archivedProject","name":"Archived project","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","archivedAt":"$CHAT_DATE"},
                    {"id":"${id(204)}","name":"Archived empty","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","archivedAt":"$CHAT_DATE"}
                    ],"latestEventId":null,"latestSeqId":0}"""
                    )
                }
                fixture.snapshot = {
                    jsonResponse(
                        """{"url":"${fixture.server.url("/archive")}","expiresInSeconds":60,"latestEventId":"$CHAT_EVENT","latestSeqId":17}"""
                    )
                }
                fixture.archive = {
                    val rows =
                        listOf(
                            row(1, CHAT_PROJECT, agent = CHAT_OTHER_AGENT),
                            row(2, CHAT_PROJECT, archived = true),
                            row(3, CHAT_PROJECT, archived = true, muted = true),
                            row(4, archivedProject, agent = CHAT_OTHER_AGENT),
                            row(5, archivedProject, archived = true, muted = true),
                            row(6, archivedProject, hidden = true),
                            row(7),
                            row(8, archived = true),
                            row(9, agent = CHAT_OTHER_AGENT),
                            row(10, muted = true),
                        )
                    jsonResponse("""{"chatThreads":[${rows.joinToString(",")}]}""")
                }
                fixture.indicators = {
                    val unread = (1..10).joinToString(",") { "\"${id(it)}\":\"unread\"" }
                    jsonResponse("""{"agents":{},"threads":{$unread},"unreadAt":{}}""")
                }
                val state =
                    ChatListUiState(
                        projectsEnabled = true,
                        projects =
                            replayProjects(
                                ProjectSync(fixture.service).synchronize(null).checkpoint
                            ),
                        threads =
                            replayChats(ChatListSync(fixture.service).synchronize(null).checkpoint),
                        agents = fixture.service.agents(),
                        indicators = fixture.service.indicators(),
                    )

                val recent = chatListGroups(state)
                assertEquals(
                    listOf("Active", "Active empty"),
                    recent.mapNotNull { it.project?.name },
                )
                assertEquals(listOf(id(1)), recent.first().threads.map { it.id })
                assertEquals(listOf(id(10), id(7)), recent.last().threads.map { it.id })

                val unread = chatListGroups(state.copy(filter = ChatListFilter.Unread))
                assertEquals(listOf("Active"), unread.mapNotNull { it.project?.name })
                // Native Unread retains archived children of active parents, but excludes muted
                // chats.
                assertEquals(listOf(id(2), id(1)), unread.first().threads.map { it.id })
                assertEquals(listOf(id(8), id(7)), unread.last().threads.map { it.id })

                val muted = chatListGroups(state.copy(filter = ChatListFilter.Muted))
                assertEquals(listOf("Active"), muted.mapNotNull { it.project?.name })
                assertEquals(listOf(id(3)), muted.first().threads.map { it.id })
                assertEquals(listOf(id(10)), muted.last().threads.map { it.id })

                val archived = chatListGroups(state.copy(filter = ChatListFilter.Archived))
                assertEquals(
                    listOf("Active", "Archived project", "Archived empty"),
                    archived.mapNotNull { it.project?.name },
                )
                assertEquals(listOf(id(3), id(2)), archived.first().threads.map { it.id })
                assertEquals(listOf(id(5), id(4)), archived[1].threads.map { it.id })
                assertTrue(archived[2].threads.isEmpty())
                assertEquals(listOf(id(8)), archived.last().threads.map { it.id })
            }
        }

    private fun id(value: Int) = "70000000-0000-4000-8000-${value.toString().padStart(12, '0')}"

    private fun row(
        index: Int,
        project: String? = null,
        archived: Boolean = false,
        muted: Boolean = false,
        hidden: Boolean = false,
        agent: String = CHAT_AGENT,
    ): String =
        """{"id":"${id(index)}","agentId":"$agent","projectId":${project?.let { "\"$it\"" } ?: "null"},
        "title":"Chat $index","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","sortAt":"$CHAT_DATE",
        "pinnedAt":null,"archived":$archived,"muted":$muted,"hidden":$hidden,"renamedAt":null}"""
}
