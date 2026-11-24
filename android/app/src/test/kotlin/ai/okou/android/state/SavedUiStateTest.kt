package ai.okou.android.state

import ai.okou.android.OkouTheme
import ai.okou.android.R
import ai.okou.android.TestOkouApplication
import ai.okou.android.artifacts.ArtifactKind
import ai.okou.android.chat.ArtifactSearchPaging
import ai.okou.android.chat.ChatListReadFailure
import ai.okou.android.chat.ChatListSource
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ConfirmedChat
import ai.okou.android.chat.SearchArtifactHit
import ai.okou.android.chat.SearchMessageHit
import ai.okou.android.chat.SearchRead
import ai.okou.android.chat.SearchWorkflowHit
import ai.okou.android.chat.WorkspaceSearchResults
import ai.okou.android.chat.WorkspaceSearchScreen
import ai.okou.android.chat.WorkspaceSearchType
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
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
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
    fun workflowRouteRestoresItsAutomationTabAndResourcesReturnRow() {
        val restoration = StateRestorationTester(compose)
        val expected =
            WorkflowsRoute(
                mode = WorkflowsMode.Directory,
                id = "release-workflow",
                tab = WorkflowTab.Automations,
                resourceReturnRow = "workflow:release-workflow",
            )
        var observed = WorkflowsRoute()
        restoration.setContent {
            var route by rememberWorkflowsRoute()
            SideEffect { observed = route }
            OkouTheme(false) {
                Button(onClick = { route = expected }) { Text("Open automation resources") }
            }
        }
        compose.onNodeWithText("Open automation resources").performClick()
        restoration.emulateSavedInstanceStateRestore()
        compose.runOnIdle { assertEquals(expected, observed) }
    }

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
                    focusOnEntry = false,
                    onFocused = {},
                    onClose = {},
                    onOpen = {},
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
    fun searchDistinguishesWorkspacePreparationFromEmptyMessageResults() {
        val search = ChatSearchState(TextFieldValue("Release"), type = WorkspaceSearchType.Messages)
        var preparation by mutableStateOf<SearchRead<Nothing>?>(SearchRead.Loading)
        var remote by mutableStateOf<WorkspaceSearchResults?>(null)
        compose.setContent {
            OkouTheme(false) {
                WorkspaceSearchScreen(
                    state = ChatListUiState(),
                    search = search,
                    widthDp = 400,
                    listWidth = null,
                    focusOnEntry = false,
                    onFocused = {},
                    onClose = {},
                    onOpen = {},
                    remote = remote,
                    workspacePreparation = preparation,
                )
            }
        }
        val noMatches = compose.onNodeWithText("No matching messages")
        val unavailable = compose.onNodeWithText("Couldn’t search messages")
        noMatches.assertDoesNotExist()
        compose.mainClock.advanceTimeBy(280)
        compose.onNodeWithContentDescription("Searching…").assertIsDisplayed()
        compose.runOnIdle { preparation = SearchRead.Failed }
        unavailable.assertIsDisplayed()
        noMatches.assertDoesNotExist()

        compose.runOnIdle {
            remote =
                WorkspaceSearchResults(
                    keyword = "Release",
                    messages = SearchRead.Ready(emptyList()),
                )
        }
        unavailable.assertDoesNotExist()
        noMatches.assertIsDisplayed()
    }

    @Test
    fun searchReportsReadFailuresAndShowsConfirmedEmptyResultsWithAnOfflineSignal() {
        val search = ChatSearchState(TextFieldValue("Release"))
        val savedChat = searchResult("release", "Release notes")
        var chats by
            mutableStateOf(
                ChatListUiState(
                    offline = true,
                    confirmedAt = 1L,
                    threadsByRecency = listOf(savedChat),
                ),
            )
        var remote by
            mutableStateOf(
                WorkspaceSearchResults(
                    keyword = "Release",
                    messages = SearchRead.Failed,
                    artifacts = SearchRead.Ready(emptyList()),
                ),
            )
        compose.setContent {
            OkouTheme(false) {
                WorkspaceSearchScreen(
                    state = chats,
                    search = search,
                    widthDp = 400,
                    listWidth = null,
                    focusOnEntry = false,
                    onFocused = {},
                    onClose = {},
                    onOpen = {},
                    remote = remote,
                    onOpenArtifact = {},
                )
            }
        }
        compose.onNodeWithText("Release notes").assertIsDisplayed()
        compose.onNodeWithText("Some results couldn’t load").assertIsDisplayed()
        val retry = compose.onNodeWithText(compose.activity.getString(R.string.retry))
        retry.assertDoesNotExist()
        compose.onNodeWithTag("search_type_Messages").performClick()
        compose
            .onNodeWithText("Couldn’t search messages")
            .assertIsDisplayed()
            .assert(
                SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite),
            )
        compose.onNodeWithText("No matching messages").assertDoesNotExist()
        retry.assertDoesNotExist()

        compose.runOnIdle {
            search.edit(TextFieldValue("Deployment"))
            remote = WorkspaceSearchResults(keyword = "Deployment", messages = SearchRead.Retrying)
        }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(280)
        compose
            .onNodeWithContentDescription("Searching…")
            .assertIsDisplayed()
            .assert(!searchProgress)
        compose.onNodeWithText("Couldn’t search messages").assertDoesNotExist()

        compose.runOnIdle { remote = remote.copy(messages = SearchRead.Ready(emptyList())) }
        compose.onNodeWithText("No matching messages").assertIsDisplayed()
        compose.onNodeWithText("Search all types").assertIsDisplayed()
        compose.onNodeWithText("Couldn’t search messages").assertDoesNotExist()
        compose.onNodeWithContentDescription("Searching…").assertDoesNotExist()

        compose.runOnIdle {
            remote = remote.copy(messages = SearchRead.Ready(emptyList(), refreshing = true))
        }
        compose.mainClock.advanceTimeBy(280)
        compose.onNodeWithText("No matching messages").assertIsDisplayed()
        compose.onNodeWithText("Search all types").assertIsDisplayed()
        compose.onNodeWithContentDescription("Searching…").assertDoesNotExist()

        compose.onNodeWithText("Search all types").performClick()
        compose.mainClock.advanceTimeBy(280)
        compose.onNodeWithText("No matching results").assertDoesNotExist()
        compose.onNodeWithContentDescription("Searching…").assertIsDisplayed()
        compose.runOnIdle {
            remote =
                remote.copy(
                    messages = SearchRead.Ready(emptyList()),
                    artifacts = SearchRead.Ready(emptyList()),
                )
        }
        compose.onNodeWithText("No matching results").assertIsDisplayed()

        compose.runOnIdle {
            search.selectType(WorkspaceSearchType.Chats)
            chats =
                ChatListUiState(
                    listPhase = ChatReadPhase.Failed,
                    listReadFailure = ChatListReadFailure.Retrying,
                )
        }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(280)
        compose.onNodeWithContentDescription("Loading chats…").assertIsDisplayed()
        compose.onNodeWithText("No matching chats").assertDoesNotExist()
        retry.assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h400dp")
    fun searchInsertsPartialFailureAboveResultsAndKeepsTheScrolledRowInPlace() {
        val search = ChatSearchState(TextFieldValue("Release"))
        var chats by
            mutableStateOf(List(3) { index -> searchResult("chat-$index", "Release chat $index") })
        val workflows =
            List(3) { index ->
                SearchWorkflowHit(
                    "workflow-$index",
                    "release-$index",
                    "Release workflow $index",
                    null,
                    true,
                )
            }
        var remote by mutableStateOf(WorkspaceSearchResults(keyword = "Release"))
        compose.setContent {
            OkouTheme(false) {
                WorkspaceSearchScreen(
                    state = ChatListUiState(confirmedAt = 1, threadsByRecency = chats),
                    search = search,
                    widthDp = 400,
                    listWidth = null,
                    focusOnEntry = false,
                    onFocused = {},
                    onClose = {},
                    onOpen = {},
                    remote = remote,
                    workflowResults = SearchRead.Ready(workflows),
                    onOpenWorkflow = {},
                )
            }
        }
        val progress = compose.onNode(searchProgress)
        val notice = compose.onNodeWithText("Some results couldn’t load")
        val first = compose.onNodeWithText("Release chat 0")
        val scrolled = compose.onNodeWithText("Release chat 2")
        val results = compose.onNodeWithTag("chat_search_results")
        compose.mainClock.advanceTimeBy(260)
        progress.assertIsDisplayed()
        compose.onNode(hasContentDescription("Searching…") and !searchProgress).assertDoesNotExist()
        first.assertIsDisplayed()
        results.performScrollToIndex(3)
        val top = scrolled.fetchSemanticsNode().boundsInRoot.top

        compose.runOnIdle { remote = remote.copy(messages = SearchRead.Retrying) }
        progress.assertIsDisplayed()
        compose.runOnIdle { remote = remote.copy(messages = SearchRead.Failed) }
        progress.assertDoesNotExist()
        assertEquals(top, scrolled.fetchSemanticsNode().boundsInRoot.top)

        results.performScrollToIndex(0)
        notice.assertIsDisplayed()
        compose.runOnIdle { remote = remote.copy(messages = SearchRead.Loading) }
        first.assertIsDisplayed()
        compose.runOnIdle { remote = remote.copy(messages = SearchRead.Failed) }
        notice.assertIsDisplayed()
        assertTrue(
            notice.fetchSemanticsNode().boundsInRoot.top <
                first.fetchSemanticsNode().boundsInRoot.top,
        )

        compose.runOnIdle { remote = remote.copy(messages = SearchRead.Ready(emptyList())) }
        compose.runOnIdle { search.position.requestScrollToItem(0, 8) }
        val firstTop = first.fetchSemanticsNode().boundsInRoot.top
        compose.runOnIdle { chats = listOf(searchResult("new", "Release newest")) + chats }
        assertEquals(firstTop, first.fetchSemanticsNode().boundsInRoot.top)
    }

    @Test
    fun artifactSearchUsesFixedDelayedProgressWhileKeepingLoadedRows() {
        val search =
            ChatSearchState(TextFieldValue("Release"), type = WorkspaceSearchType.Artifacts)
        val first = SearchArtifactHit("first", "Release brief", ArtifactKind.File)
        var remote by
            mutableStateOf(
                WorkspaceSearchResults(
                    "Release",
                    messages = SearchRead.Ready(emptyList()),
                    artifacts = SearchRead.Ready(listOf(first), "next"),
                ),
            )
        compose.setContent {
            OkouTheme(false) {
                WorkspaceSearchScreen(
                    state = ChatListUiState(confirmedAt = 1),
                    search = search,
                    widthDp = 400,
                    listWidth = null,
                    focusOnEntry = false,
                    onFocused = {},
                    onClose = {},
                    onOpen = {},
                    remote = remote,
                    onOpenArtifact = {},
                )
            }
        }
        val row = compose.onNodeWithText(first.title)
        val top = row.fetchSemanticsNode().boundsInRoot.top
        val progress = compose.onNode(searchProgress)
        compose
            .onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo))
            .assertDoesNotExist()

        compose.runOnIdle { remote = remote.copy(artifactPaging = ArtifactSearchPaging.Loading) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(180)
        progress.assertDoesNotExist()
        compose.mainClock.advanceTimeBy(100)
        progress.assertIsDisplayed()
        assertEquals(top, row.fetchSemanticsNode().boundsInRoot.top)

        compose.runOnIdle { search.selectType(WorkspaceSearchType.All) }
        compose.mainClock.advanceTimeBy(280)
        progress.assertDoesNotExist()
        row.assertIsDisplayed()
        compose.runOnIdle { search.selectType(WorkspaceSearchType.Artifacts) }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(280)
        progress.assertIsDisplayed()
        compose.runOnIdle { remote = remote.copy(artifactPaging = ArtifactSearchPaging.Failed) }
        progress.assertDoesNotExist()
        row.assertIsDisplayed()
        compose.onNodeWithText("Couldn’t refresh. Showing previous results.").assertIsDisplayed()

        compose.runOnIdle {
            remote =
                remote.copy(
                    artifacts = SearchRead.Ready(emptyList(), "next"),
                    artifactPaging = ArtifactSearchPaging.Idle,
                )
        }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(280)
        compose.onNodeWithText("No matching artifacts").assertDoesNotExist()
        compose.onNodeWithContentDescription("Searching…").assertIsDisplayed()
        compose.runOnIdle { remote = remote.copy(artifacts = SearchRead.Ready(emptyList())) }
        compose.onNodeWithText("No matching artifacts").assertIsDisplayed()
    }

    @Test
    fun searchShowsProgressWhileResolvingTheChatForAMessageResult() {
        val search = ChatSearchState(TextFieldValue("Release"))
        val knownChat = searchResult("known", "Release brief")
        val missingChat = searchResult("missing", "Design review")
        val message = SearchMessageHit("missing", 1L, "Check the release brief", listOf(10..16))
        var list by
            mutableStateOf(
                ChatListUiState(
                    confirmedAt = 1,
                    listPhase = ChatReadPhase.Loading,
                    threadsByRecency = listOf(knownChat),
                ),
            )
        compose.setContent {
            OkouTheme(false) {
                WorkspaceSearchScreen(
                    state = list,
                    search = search,
                    widthDp = 400,
                    listWidth = null,
                    focusOnEntry = false,
                    onFocused = {},
                    onClose = {},
                    onOpen = {},
                    remote =
                        WorkspaceSearchResults(
                            "Release",
                            messages = SearchRead.Ready(listOf(message)),
                        ),
                )
            }
        }
        val row = compose.onNodeWithText(knownChat.title!!)
        val top = row.fetchSemanticsNode().boundsInRoot.top
        val progress = compose.onNode(searchProgress)
        compose.mainClock.advanceTimeBy(280)
        progress.assertIsDisplayed()
        assertEquals(top, row.fetchSemanticsNode().boundsInRoot.top)

        compose.runOnIdle {
            list =
                list.copy(
                    listPhase = ChatReadPhase.Idle,
                    threadsByRecency = listOf(knownChat, missingChat),
                )
        }
        progress.assertDoesNotExist()
        row.assertIsDisplayed()
        compose.onNodeWithText(message.content).assertIsDisplayed()
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
    fun searchRestoresTheSameOffsetWhenTheSavedResultDisappears() {
        checkSearchRestoration("Result", "Result 5", replacementTitle = "Result 6")
    }

    @Test
    fun searchRestoresResultFocusBeforeAnUnrelatedScrollAnchorReloads() {
        val restoration = StateRestorationTester(compose)
        val date = "2026-11-13T00:00:00Z"
        val chat =
            ConfirmedChat(
                id = "chat",
                title = "Planning conversation",
                sortAt = date,
                createdAt = date,
                updatedAt = date,
                pinnedAt = null,
                archived = false,
                renamedAt = null,
            )
        val message = SearchMessageHit(chat.id, 1, "Release reply", listOf(0..6))
        val workflow = SearchWorkflowHit("workflow", "release", "Release workflow", null, true)
        val loaded =
            WorkspaceSearchResults(
                keyword = "Release",
                messages = SearchRead.Ready(listOf(message)),
            )
        var remote by mutableStateOf(loaded)
        var detailsOpen by mutableStateOf(false)
        restoration.setContent {
            val search = rememberChatSearchState()
            OkouTheme(false) {
                if (detailsOpen) {
                    Text("Workflow detail")
                } else {
                    WorkspaceSearchScreen(
                        state = ChatListUiState(confirmedAt = 1, threadsByRecency = listOf(chat)),
                        search = search,
                        widthDp = 400,
                        listWidth = null,
                        focusOnEntry = false,
                        onFocused = {},
                        onClose = {},
                        onOpen = {},
                        remote = remote,
                        workflowResults = SearchRead.Ready(listOf(workflow)),
                        onOpenWorkflow = { detailsOpen = true },
                    )
                }
            }
        }

        val query = compose.onNodeWithTag("chat_search_query")
        val result = compose.onNodeWithText(workflow.title)
        query.performTextInput("Release")
        compose.onNodeWithText(message.content).assertIsDisplayed()
        result.performClick()
        compose.onNodeWithText("Workflow detail").assertIsDisplayed()

        restoration.emulateSavedInstanceStateRestore()
        compose.runOnIdle {
            remote = loaded.copy(messages = SearchRead.Retrying)
            detailsOpen = false
        }
        query.assertTextContains("Release")
        result.assertIsDisplayed().assertIsFocused()

        compose.runOnIdle { remote = loaded }
        compose.onNodeWithText(message.content).assertIsDisplayed()
        result.assertIsFocused()
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
        replacementTitle: String? = null,
    ) {
        val restoration = StateRestorationTester(compose)
        var source by mutableStateOf(ChatListSource.Network)
        var rows by
            mutableStateOf(List(40) { index -> searchResult(index.toString(), "$query $index") })
        lateinit var currentSearch: ChatSearchState
        restoration.setContent {
            DisposableEffect(Unit) {
                onDispose {
                    source = ChatListSource.Cache
                    rows =
                        if (replacementTitle == null)
                            listOf(rows.first().copy(id = "new", title = "$query newest")) + rows
                        else rows.filterNot { it.title == targetTitle }
                }
            }
            val search = rememberChatSearchState()
            SideEffect { currentSearch = search }
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
                    focusOnEntry = false,
                    onFocused = {},
                    onClose = {},
                    onOpen = {},
                )
            }
        }
        val results = compose.onNodeWithTag("chat_search_results")
        val field = compose.onNodeWithTag("chat_search_query")
        compose.onNodeWithText("Chats").performClick()
        field.performTextInput(query)
        val target = compose.onNodeWithText(targetTitle)
        results.performScrollToIndex(6)
        if (replacementTitle != null) {
            compose.runOnIdle { currentSearch.position.requestScrollToItem(6, 12) }
            compose.runOnIdle {
                assertEquals(12, currentSearch.position.firstVisibleItemScrollOffset)
            }
        }
        val originalTop = target.fetchSemanticsNode().boundsInRoot.top
        restoration.emulateSavedInstanceStateRestore()
        if (queryIsSaved) {
            field.assert(hasText(query))
            val restored = replacementTitle?.let { compose.onNodeWithText(it) } ?: target
            assertEquals(originalTop, restored.fetchSemanticsNode().boundsInRoot.top)
            if (replacementTitle != null) {
                compose.runOnIdle {
                    assertEquals(12, currentSearch.position.firstVisibleItemScrollOffset)
                }
            }
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

    private val searchProgress =
        hasContentDescription("Searching…") and
            SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)

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
