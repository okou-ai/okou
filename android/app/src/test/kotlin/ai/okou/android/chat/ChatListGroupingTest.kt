package ai.okou.android.chat

import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.IndicatorsThreadsValue
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.v2.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class ChatListGroupingTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun inboxKeepsGroupsWhileUnreadFilterFollowsEffectiveMembership() {
        val timestamp = "2026-11-13T00:00:00Z"
        val thread =
            ConfirmedChat(
                id = "chat",
                title = "Chat",
                sortAt = timestamp,
                createdAt = timestamp,
                updatedAt = timestamp,
                pinnedAt = timestamp,
                archived = false,
                renamedAt = null,
            )
        val state = mutableStateOf(ChatListUiState(threads = listOf(thread)))
        lateinit var renderedGroups: List<ChatListGroup>
        compose.setContent {
            val current = state.value
            val groups =
                rememberChatListGroups(
                    current.threads,
                    current.projects,
                    current.filter,
                    current.unreadChatIds(),
                    emptySet(),
                )
            SideEffect { renderedGroups = groups }
        }

        val inbox = compose.runOnIdle { renderedGroups }
        val unread =
            Indicators(
                mapOf(thread.id to IndicatorsThreadsValue.UNREAD),
                mapOf(thread.id to timestamp),
            )
        val running = unread.copy(threads = mapOf(thread.id to IndicatorsThreadsValue.ACTIVE))
        val markRead = mapOf(thread.id to ChatReadIntent(ChatRowAction.MarkRead, timestamp))

        compose.runOnIdle { state.value = state.value.copy(indicators = unread) }
        compose.runOnIdle {
            assertSame(inbox, renderedGroups)
            state.value = state.value.copy(indicators = running, readIntents = markRead)
        }
        compose.runOnIdle {
            assertSame(inbox, renderedGroups)
            state.value = state.value.copy(filter = ChatListFilter.Unread, readIntents = emptyMap())
        }
        val unreadGroups =
            compose.runOnIdle {
                assertEquals(listOf(thread), renderedGroups.single().threads)
                renderedGroups
            }
        compose.runOnIdle { state.value = state.value.copy(indicators = unread) }
        compose.runOnIdle {
            assertSame(unreadGroups, renderedGroups)
            state.value = state.value.copy(readIntents = markRead)
        }
        val optimisticGroups =
            compose.runOnIdle {
                assertTrue(renderedGroups.single().threads.isEmpty())
                renderedGroups
            }
        compose.runOnIdle {
            state.value =
                state.value.copy(
                    indicators = Indicators(emptyMap(), emptyMap()),
                    readIntents = emptyMap(),
                )
        }
        compose.runOnIdle { assertSame(optimisticGroups, renderedGroups) }
    }
}
