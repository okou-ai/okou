package ai.okou.android.state

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import ai.okou.android.chat.ChatListSource
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ConfirmedChat
import ai.okou.android.chat.WorkspaceSearchScreen
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = TestOkouApplication::class)
class SavedUiStateTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun searchWaitsForTheImeToCommitTheNewKeyword() {
        val search = ChatSearchState(TextFieldValue("发"))
        val composing = TextFieldValue("发bu", composition = TextRange(1, 3))
        search.edit(composing)
        assertEquals("发bu", search.query.text)
        assertEquals("发", search.keyword)
        assertEquals("发", search.savedQuery().text)
        search.edit(TextFieldValue("发布"))
        assertEquals("发布", search.keyword)
    }

    @Test
    fun searchKeepsPresentedResultsAndSelectionUntilCompositionEnds() {
        val search = ChatSearchState(TextFieldValue("Release"))
        val date = "2026-11-13T00:00:00Z"
        val chat =
            ConfirmedChat(
                id = "chat",
                agentId = "agent",
                title = "Release before refresh",
                sortAt = date,
                createdAt = date,
                updatedAt = date,
                pinnedAt = null,
                archived = false,
                renamedAt = null,
            )
        var row by mutableStateOf(chat)
        compose.setContent {
            OkouTheme(false) {
                WorkspaceSearchScreen(
                    state = ChatListUiState(confirmedAt = 1, threadsByRecency = listOf(row)),
                    search = search,
                    widthDp = 400,
                    listWidth = null,
                    workspaceName = null,
                    focusOnEntry = false,
                    onFocused = {},
                    onClose = {},
                    onOpen = {},
                    retry = {},
                )
            }
        }
        compose.onNodeWithText(chat.title!!).assertIsDisplayed()
        val composing =
            TextFieldValue("Releasebu", selection = TextRange(8), composition = TextRange(7, 9))
        compose.runOnIdle { search.edit(composing) }
        compose.runOnIdle { row = chat.copy(title = "Release after refresh") }
        compose.onNodeWithText("Release before refresh").assertIsDisplayed()
        compose.onNodeWithText("Release after refresh").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(composing, search.query)
            search.edit(TextFieldValue("Release", selection = TextRange(7)))
        }
        compose.onNodeWithText("Release after refresh").assertIsDisplayed()
    }

    @Test
    fun searchRestoresTheSameResultWhenCacheAddsAnEarlierMatch() {
        checkSearchRestoration("Result", "Result 5")
    }

    @Test
    fun searchDropsTheOldResultPositionWhenTheQueryIsTooLongToRestore() {
        val longQuery = "Result " + "x".repeat(256)
        checkSearchRestoration(longQuery, "$longQuery 5", queryIsSaved = false)
    }

    private fun checkSearchRestoration(
        query: String,
        targetTitle: String,
        queryIsSaved: Boolean = true,
    ) {
        val restoration = StateRestorationTester(compose)
        var source by mutableStateOf(ChatListSource.Network)
        var rows by
            mutableStateOf(
                List(40) { index ->
                    val date = "2026-11-13T00:00:00Z"
                    ConfirmedChat(
                        id = index.toString(),
                        agentId = "agent",
                        title = "$query $index",
                        sortAt = date,
                        createdAt = date,
                        updatedAt = date,
                        pinnedAt = null,
                        archived = false,
                        renamedAt = null,
                    )
                }
            )
        restoration.setContent {
            DisposableEffect(Unit) {
                onDispose {
                    source = ChatListSource.Cache
                    rows = listOf(rows.first().copy(id = "new", title = "$query newest")) + rows
                }
            }
            val search = rememberChatSearchState()
            OkouTheme(false) {
                WorkspaceSearchScreen(
                    state =
                        ChatListUiState(
                            listPhase = ChatReadPhase.Ready,
                            confirmedAt = 1,
                            source = source,
                            threadsByRecency = rows,
                        ),
                    search = search,
                    widthDp = 400,
                    listWidth = null,
                    workspaceName = null,
                    focusOnEntry = false,
                    onFocused = {},
                    onClose = {},
                    onOpen = {},
                    retry = {},
                )
            }
        }
        val results = compose.onNodeWithTag("chat_search_results")
        val field = compose.onNodeWithTag("chat_search_query")
        compose.onNodeWithText("Chats").performClick()
        field.performTextInput(query)
        val target = compose.onNodeWithText(targetTitle)
        results.performScrollToIndex(6)
        val originalTop = target.fetchSemanticsNode().boundsInRoot.top
        restoration.emulateSavedInstanceStateRestore()
        if (queryIsSaved) {
            field.assert(hasText(query))
            assertEquals(originalTop, target.fetchSemanticsNode().boundsInRoot.top)
        } else {
            compose.onNodeWithText("Recent chats").assertIsDisplayed()
            compose.onNodeWithText("$query newest").assertIsDisplayed()
        }
    }

    @Test
    fun restoredSelectionWaitsForTheJournalBody() {
        val restoration = StateRestorationTester(compose)
        var text by mutableStateOf<String?>("Journal-owned draft")
        restoration.setContent {
            DisposableEffect(Unit) { onDispose { text = null } }
            val editing = rememberJournalEditor(text, "thread")
            OkouTheme(false) {
                OutlinedTextField(
                    value = editing.value,
                    onValueChange = {
                        editing.edit(it)
                        text = it.text
                    },
                    enabled = text != null,
                    modifier = Modifier.testTag("journal_editor"),
                )
            }
        }
        val field = compose.onNodeWithTag("journal_editor")
        field.performTextInputSelection(TextRange(7))
        restoration.emulateSavedInstanceStateRestore()
        field.assertIsNotEnabled()
        compose.runOnIdle { text = "Journal-owned draft" }
        field.assertTextContains("Journal-owned draft")
        assertEquals(
            TextRange(7),
            field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
    }

    @Test
    fun recentConversationScrollRestoresAndOldPresentationIsEvicted() {
        val restoration = StateRestorationTester(compose)
        var next = 0
        restoration.setContent {
            val histories = rememberConversationUiState()
            var navigation by rememberWorkspaceNavigation()
            fun open(id: Int) {
                val target = "00000000-0000-4000-8000-${id.toString().padStart(12, '0')}"
                histories.open(target)
                navigation = WorkspaceNavigation(WorkspaceTarget.Chat(target))
            }
            OkouTheme(false) {
                Column {
                    Button(onClick = { open(++next) }) { Text("Next conversation") }
                    Button(onClick = { open(1) }) { Text("First conversation") }
                    Button(onClick = { open(SavedStatePolicy.CONVERSATION_STATES) }) {
                        Text("Recent conversation")
                    }
                    (navigation.target as? WorkspaceTarget.Chat)?.id?.let { id ->
                        histories.Content(id) {
                            val position = rememberLazyListState()
                            LazyColumn(
                                state = position,
                                modifier = Modifier.height(300.dp).testTag("retained_history"),
                            ) {
                                items((0..99).toList()) { row ->
                                    Text("History row $row", Modifier.height(40.dp))
                                }
                            }
                        }
                    }
                }
            }
        }
        compose.onNodeWithText("Next conversation").performClick()
        compose.onNodeWithTag("retained_history").performScrollToIndex(60)
        for (id in 2..SavedStatePolicy.CONVERSATION_STATES + 1) {
            compose.onNodeWithText("Next conversation").performClick()
            if (id == SavedStatePolicy.CONVERSATION_STATES)
                compose.onNodeWithTag("retained_history").performScrollToIndex(70)
        }
        compose.onNodeWithText("First conversation").performClick()
        compose.onNodeWithText("History row 0").assertIsDisplayed()
        compose.onNodeWithText("Recent conversation").performClick()
        compose.onNodeWithText("History row 70").assertIsDisplayed()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("History row 70").assertIsDisplayed()
        compose.runOnIdle {
            val saved = Bundle()
            InstrumentationRegistry.getInstrumentation()
                .callActivityOnSaveInstanceState(compose.activity, saved)
            SavedStatePolicy.verify(saved)
        }
    }
}
