package ai.okou.android

import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.IndicatorsThreadsValue
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.ChatMarkAllReadResult
import ai.okou.android.chat.ChatReadIntent
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ChatRowAction
import ai.okou.android.chat.ProvisionalChat
import ai.okou.android.chat.isUnread
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class WorkspaceChatNavigationTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun listOnlyUpdatesReachTheirConsumerWithoutInvalidatingNavigation() {
        val thread = "chat"
        val list = mutableStateOf(ChatListUiState(listPhase = ChatReadPhase.Loading))
        var navigationRenders = 0
        compose.setContent {
            val navigation = rememberWorkspaceChatNavigation(list).value
            Column {
                Text("${navigation.listPhase} ${navigation.acceptedNewChats.size}")
                ListFeedback(list, thread)
            }
            SideEffect { navigationRenders++ }
        }
        compose.onNodeWithText("Loading 0").assertIsDisplayed()
        val baseline = compose.runOnIdle { navigationRenders }
        compose.runOnIdle {
            list.value =
                list.value.copy(
                    indicators =
                        Indicators(
                            mapOf(thread to IndicatorsThreadsValue.UNREAD),
                            mapOf(thread to "2026-11-22T00:00:00Z"),
                        ),
                    pendingRowActions = mapOf(thread to ChatRowAction.MarkRead),
                    readIntents =
                        mapOf(
                            thread to ChatReadIntent(ChatRowAction.MarkRead, "2026-11-22T00:00:00Z")
                        ),
                    markAllReadResult = ChatMarkAllReadResult(1, 1),
                )
        }
        compose.onNodeWithText("false 1 1").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(baseline, navigationRenders)
            list.value =
                list.value.copy(
                    listPhase = ChatReadPhase.Ready,
                    acceptedNewChats = listOf(ProvisionalChat(thread, null)),
                )
        }
        compose.onNodeWithText("Ready 1").assertIsDisplayed()
    }
}

@Composable
private fun ListFeedback(list: State<ChatListUiState>, thread: String) {
    val state = list.value
    Text(
        "${state.isUnread(thread)} ${state.pendingRowActions.size} ${state.markAllReadResult?.confirmed}"
    )
}
