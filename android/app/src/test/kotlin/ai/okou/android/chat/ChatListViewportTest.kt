package ai.okou.android.chat

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = TestOkouApplication::class)
class ChatListViewportTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun aReaderAtTheEndFollowsNewRowsAndViewportChanges() {
        val height = mutableStateOf(480.dp)
        val projectCount = mutableStateOf(0)
        val rowCount = mutableStateOf(30)
        compose.setContent {
            OkouTheme {
                val listState = rememberLazyListState()
                ChatListViewport(
                    Modifier.fillMaxWidth().height(height.value),
                    listState,
                    contentChangeKey = projectCount.value to "chat_${rowCount.value - 1}",
                    status = ChatListStatus.Offline,
                    newChatEnabled = true,
                    newChat = {},
                    feedback = {},
                ) { bottomSpace, _ ->
                    LazyColumn(
                        Modifier.testTag("rows"),
                        state = listState,
                        contentPadding = PaddingValues(bottom = bottomSpace),
                    ) {
                        items(projectCount.value, key = { "project_$it" }) { index ->
                            Box(Modifier.fillMaxWidth().height(52.dp)) { Text("Project $index") }
                        }
                        items(rowCount.value, key = { it }) { index ->
                            Box(Modifier.fillMaxWidth().height(52.dp).testTag("chat_$index")) {
                                Text("Chat $index")
                            }
                        }
                    }
                }
            }
        }
        val rows = compose.onNodeWithTag("rows")
        rows.performScrollToIndex(29)
        compose.onNodeWithTag("chat_29").assertIsDisplayed()

        compose.runOnIdle { rowCount.value = 32 }

        val lastRow = compose.onNodeWithTag("chat_31")
        lastRow.assertIsDisplayed()

        compose.runOnIdle { projectCount.value = 160 }
        lastRow.assertIsDisplayed()

        compose.runOnIdle { height.value = 280.dp }

        lastRow.assertIsDisplayed()
        val action = compose.onNodeWithText("New chat").getUnclippedBoundsInRoot()
        assertTrue(lastRow.getUnclippedBoundsInRoot().bottom < action.top)

        rows.performScrollToIndex(projectCount.value + 8)
        val visibleRow = compose.onNodeWithTag("chat_8")
        val position = visibleRow.getUnclippedBoundsInRoot().top

        compose.runOnIdle { rowCount.value = 33 }

        assertEquals(position, visibleRow.getUnclippedBoundsInRoot().top)
    }
}
