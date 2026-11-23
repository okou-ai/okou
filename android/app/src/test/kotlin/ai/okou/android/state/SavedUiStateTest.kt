package ai.okou.android.state

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import ai.okou.android.chat.ChatListSource
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ChatTitleSearch
import ai.okou.android.chat.ConfirmedChat
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
import androidx.compose.ui.test.assertIsFocused
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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
    fun searchKeepsTheLastResultsUntilTheImeCommits() {
        val search = ChatSearchState()
        var rows by
            mutableStateOf(
                listOf(
                    searchResult("checklist", "Release checklist"),
                    searchResult("feedback", "Customer feedback"),
                )
            )
        compose.setContent {
            OkouTheme(false) {
                ChatTitleSearch(
                    state =
                        ChatListUiState(
                            listPhase = ChatReadPhase.Ready,
                            confirmedAt = 1,
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
        val field = compose.onNodeWithTag("chat_search_query").performClick().assertIsFocused()
        val checklist = compose.onNodeWithText("Release checklist").assertIsDisplayed()
        val feedback = compose.onNodeWithText("Customer feedback").assertIsDisplayed()

        compose.runOnIdle {
            search.edit(TextFieldValue("fabu", TextRange(4), TextRange(0, 4)))
            rows = rows + searchResult("summary", "Release summary")
        }
        field.assertTextContains("fabu").assertIsFocused()
        checklist.assertIsDisplayed()
        feedback.assertIsDisplayed()
        val summary = compose.onNodeWithText("Release summary")
        summary.assertDoesNotExist()

        compose.runOnIdle { rows = rows.filterNot { it.id == "feedback" } }
        feedback.assertIsDisplayed()

        compose.runOnIdle { search.edit(TextFieldValue("Release", TextRange(7))) }
        field.assertTextContains("Release").assertIsFocused()
        checklist.assertIsDisplayed()
        summary.assertIsDisplayed()
        feedback.assertDoesNotExist()
    }

    @Test
    fun connectorSearchOnlyAppliesCommittedInput() {
        val committed = TextFieldValue("Calendar", TextRange(8))
        val composing = TextFieldValue("Calendar ri", TextRange(11), TextRange(9, 11))
        val completed = TextFieldValue("Calendar 日", TextRange(10))
        val route = ConnectorDirectoryState(query = committed)

        route.editQuery(composing)
        assertEquals(composing, route.query)
        assertEquals(committed, route.committedQuery)
        assertTrue(route.hasPendingSearchInput)

        val submitted = composing.copy(composition = null)
        route.editQuery(submitted)
        route.editQuery(composing)
        assertEquals(submitted, route.committedQuery)
        assertFalse(route.hasPendingSearchInput)

        route.editQuery(completed)
        assertEquals(completed, route.query)
        assertEquals(completed, route.committedQuery)
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
            mutableStateOf(List(40) { index -> searchResult(index.toString(), "$query $index") })
        restoration.setContent {
            DisposableEffect(Unit) {
                onDispose {
                    source = ChatListSource.Cache
                    rows = listOf(rows.first().copy(id = "new", title = "$query newest")) + rows
                }
            }
            val search = rememberChatSearchState()
            OkouTheme(false) {
                ChatTitleSearch(
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

    private fun searchResult(id: String, title: String): ConfirmedChat {
        val date = "2026-11-13T00:00:00Z"
        return ConfirmedChat(
            id = id,
            title = title,
            sortAt = date,
            createdAt = date,
            updatedAt = date,
            pinnedAt = null,
            archived = false,
            renamedAt = null,
        )
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
