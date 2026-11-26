package ai.okou.android.chat

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.artifacts.ArtifactKind
import ai.okou.android.resolvePalette
import ai.okou.android.state.ChatSearchState
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ComposeUiTestConfig
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = TestOkouApplication::class)
class WorkspaceSearchScreenTest {
    private val animationScale = mutableFloatStateOf(1f)
    private val motion =
        object : MotionDurationScale {
            override val scaleFactor: Float
                get() = animationScale.floatValue
        }
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>(ComposeUiTestConfig(motion))

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun focusedSearchUsesTheSameMaterialSurfaceAndBounds() {
        val search = ChatSearchState(TextFieldValue("Launch"))
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
                )
            }
        }

        val field = compose.onNodeWithTag("chat_search_query")
        val bounds = field.getUnclippedBoundsInRoot()
        assertEquals(48.dp, bounds.bottom - bounds.top)
        val colors = resolvePalette(UserPreferencesColorTheme.DEFAULT, dark = false)
        fun assertSurface() {
            val pixels = field.captureToImage().toPixelMap()
            assertEquals(colors.surfaceContainerHigh.toArgb(), pixels[pixels.width / 2, 0].toArgb())
        }
        assertSurface()

        field.performSemanticsAction(SemanticsActions.RequestFocus)
        field.assertIsFocused()
        assertEquals(bounds, field.getUnclippedBoundsInRoot())
        assertSurface()
    }

    @Test
    fun aLateResultDoesNotTakeFocusFromTheSearchField() {
        val search =
            ChatSearchState(TextFieldValue("Release"), type = WorkspaceSearchType.Artifacts)
        val hit = SearchArtifactHit("report", "Release report", ArtifactKind.File)
        var artifacts by mutableStateOf<SearchRead<SearchArtifactHit>>(SearchRead.Loading)
        search.returnToResult("artifact:report", InputMode.Touch)
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
                    remote = WorkspaceSearchResults("Release", artifacts = artifacts),
                    onOpenArtifact = {},
                )
            }
        }

        val input = compose.onNodeWithTag("chat_search_query")
        compose.runOnIdle { checkNotNull(search.returnFocus.pending) }
        input.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        compose.runOnIdle { artifacts = SearchRead.Ready(listOf(hit)) }

        compose.onNodeWithText(hit.title).assertIsDisplayed()
        input.assertIsFocused()
    }

    @Test
    fun artifactPageFailureScrollsWithTheResultsAndDoesNotMoveRowsDuringRetry() {
        val search =
            ChatSearchState(TextFieldValue("Release"), type = WorkspaceSearchType.Artifacts)
        val firstPage =
            (1..8).map {
                SearchArtifactHit("artifact-$it", "Release brief $it", ArtifactKind.File)
            }
        var remote by
            mutableStateOf(
                WorkspaceSearchResults(
                    "Release",
                    artifacts = SearchRead.Ready(firstPage, "next"),
                    artifactPaging = ArtifactSearchPaging.Loading,
                ),
            )
        compose.setContent {
            OkouTheme(false) {
                Box(Modifier.width(400.dp).height(320.dp)) {
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
        }

        val results = compose.onNodeWithTag("chat_search_results")
        val lastResult = compose.onNodeWithText(firstPage.last().title)
        val lastResultIndex = firstPage.size // Results follow the group heading.
        val tailIndex = lastResultIndex + 1
        results.performScrollToIndex(lastResultIndex)
        val originalBounds = lastResult.getUnclippedBoundsInRoot()
        compose.runOnIdle { remote = remote.copy(artifactPaging = ArtifactSearchPaging.Failed) }
        assertEquals(originalBounds, lastResult.getUnclippedBoundsInRoot())
        compose
            .onNodeWithText("Some search results are temporarily unavailable")
            .assertDoesNotExist()

        val failureLabel = "Temporarily unable to load more"
        val footer = compose.onNodeWithText(failureLabel)
        results.performScrollToIndex(tailIndex)
        footer.assert(
            SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite),
        )
        assertEquals(
            12.dp,
            footer.getUnclippedBoundsInRoot().top - lastResult.getUnclippedBoundsInRoot().bottom,
        )

        results.performScrollToIndex(0)
        footer.assertDoesNotExist()
        results.performScrollToIndex(tailIndex)
        val lastResultAtTail = lastResult.getUnclippedBoundsInRoot()
        val footerAtTail = footer.getUnclippedBoundsInRoot()
        compose.runOnIdle { remote = remote.copy(artifactPaging = ArtifactSearchPaging.Retrying) }
        assertEquals(lastResultAtTail, lastResult.getUnclippedBoundsInRoot())
        assertEquals(footerAtTail, footer.getUnclippedBoundsInRoot())

        val newRow = SearchArtifactHit("next-artifact", "Release notes", ArtifactKind.File)
        compose.runOnIdle {
            remote =
                remote.copy(
                    artifacts = SearchRead.Ready(firstPage + newRow),
                    artifactPaging = ArtifactSearchPaging.Idle,
                )
        }
        footer.assertDoesNotExist()
        assertEquals(lastResultAtTail, lastResult.getUnclippedBoundsInRoot())
        results.performScrollToIndex(tailIndex)
        compose.onNodeWithText(newRow.title).assertIsDisplayed()
    }

    @Test
    fun shortcutsKeepTheKeywordAndMoveFocusToTheDestinationFilter() {
        val search = ChatSearchState(TextFieldValue("Launch"))
        val artifacts =
            List(5) { SearchArtifactHit("file-$it", "Launch file $it", ArtifactKind.File) }
        compose.setContent {
            OkouTheme(false) {
                Box(Modifier.width(280.dp)) {
                    val keyword = search.keyword
                    WorkspaceSearchScreen(
                        state = ChatListUiState(confirmedAt = 1),
                        search = search,
                        widthDp = 1000,
                        listWidth = 320,
                        focusOnEntry = false,
                        onFocused = {},
                        onClose = {},
                        onOpen = {},
                        remote =
                            WorkspaceSearchResults(
                                keyword,
                                messages = SearchRead.Ready(emptyList()),
                                artifacts =
                                    SearchRead.Ready(
                                        artifacts.filter { it.title.contains(keyword) },
                                    ),
                            ),
                        onOpenArtifact = {},
                    )
                }
            }
        }

        val all = compose.onNodeWithTag("search_type_All")
        val artifactTab = compose.onNodeWithTag("search_type_Artifacts")
        val query = compose.onNodeWithTag("chat_search_query")
        assertTrue(artifactTab.getUnclippedBoundsInRoot().right > 264.dp)
        compose.onNodeWithText("Launch file 2").assertIsDisplayed()
        compose.onNodeWithText("Launch file 3").assertDoesNotExist()
        val viewAll = compose.onNodeWithContentDescription("View all Artifacts")
        val actionBounds = viewAll.getUnclippedBoundsInRoot()
        assertTrue(actionBounds.bottom - actionBounds.top >= 48.dp)
        assertTrue(actionBounds.right - actionBounds.left >= 48.dp)
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("View all", useUnmergedTree = true).performSemanticsAction(
            SemanticsActions.GetTextLayoutResult,
        ) {
            it(layouts)
        }
        val style = layouts.single().layoutInput.style
        assertEquals(
            resolvePalette(UserPreferencesColorTheme.DEFAULT, dark = false).primary,
            style.color,
        )
        assertEquals(13.sp, style.fontSize)
        assertEquals(20.sp, style.lineHeight)
        viewAll.performClick()
        query.assertTextContains("Launch")
        artifactTab.assertIsSelected().assertIsFocused()
        assertTrue(artifactTab.getUnclippedBoundsInRoot().right <= 264.dp)
        compose.onNodeWithText("Launch file 4").assertIsDisplayed()

        compose.runOnIdle { search.edit(TextFieldValue("Missing")) }
        compose.onNodeWithText("No matching artifacts").assertIsDisplayed()
        compose.onNodeWithText("Search all types").performClick()
        query.assertTextContains("Missing")
        all.assertIsSelected().assertIsFocused()
        assertEquals(16.dp, all.getUnclippedBoundsInRoot().left)
        compose.onNodeWithText("No matching results").assertIsDisplayed()
    }

    @Test
    fun aKeyboardFocusedFilterStaysVisibleWhenThePaneNarrows() {
        val search = ChatSearchState()
        var width by mutableStateOf(280.dp)
        compose.setContent {
            OkouTheme(false) {
                Box(Modifier.width(width)) {
                    WorkspaceSearchScreen(
                        state = ChatListUiState(confirmedAt = 1),
                        search = search,
                        widthDp = 1000,
                        listWidth = 320,
                        focusOnEntry = false,
                        onFocused = {},
                        onClose = {},
                        onOpen = {},
                    )
                }
            }
        }

        val all = compose.onNodeWithTag("search_type_All")
        val artifactTab = compose.onNodeWithTag("search_type_Artifacts")
        all.performSemanticsAction(SemanticsActions.RequestFocus)
        artifactTab.performSemanticsAction(SemanticsActions.RequestFocus)
        artifactTab.assertIsFocused()
        assertTrue(artifactTab.getUnclippedBoundsInRoot().right <= 264.dp)
        compose.runOnIdle { width = 256.dp }
        all.assertIsSelected()
        artifactTab.assertIsFocused()
        assertTrue(artifactTab.getUnclippedBoundsInRoot().right <= 240.dp)

        all.performSemanticsAction(SemanticsActions.RequestFocus)
        val workflowTab = compose.onNodeWithTag("search_type_Workflows")
        workflowTab.performSemanticsAction(SemanticsActions.RequestFocus)
        workflowTab.assertIsFocused()
        val end = workflowTab.getUnclippedBoundsInRoot().right
        assertTrue("The focused filter ends inside the fade at $end", end <= 224.dp)
    }

    @Test
    fun groupSpacingDependsOnTheDisplayedGroups() {
        val search = ChatSearchState(TextFieldValue("Launch"))
        val date = "2026-11-13T00:00:00Z"
        val chat =
            ConfirmedChat(
                id = "chat",
                title = "Launch plan",
                sortAt = date,
                createdAt = date,
                updatedAt = date,
                pinnedAt = null,
                archived = false,
                renamedAt = null,
            )
        var chats by mutableStateOf(emptyList<ConfirmedChat>())
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
                    remote =
                        WorkspaceSearchResults(
                            "Launch",
                            messages = SearchRead.Ready(emptyList()),
                            artifacts =
                                SearchRead.Ready(
                                    listOf(
                                        SearchArtifactHit(
                                            "file",
                                            "Launch brief",
                                            ArtifactKind.File,
                                        ),
                                    ),
                                ),
                        ),
                    onOpenArtifact = {},
                )
            }
        }

        val results = hasAnyAncestor(hasTestTag("chat_search_results"))
        val firstArtifactHeading = compose.onNode(hasText("Artifacts") and results)
        val firstHeadingBounds = firstArtifactHeading.getUnclippedBoundsInRoot()
        val resultsTop = compose.onNodeWithTag("chat_search_results").getUnclippedBoundsInRoot().top
        assertEquals(14.dp, firstHeadingBounds.top - resultsTop)

        compose.runOnIdle { chats = listOf(chat) }
        val firstChatHeading = compose.onNode(hasText("Chats") and results)
        assertEquals(firstHeadingBounds.top, firstChatHeading.getUnclippedBoundsInRoot().top)
        val chatBottom = compose.onNodeWithText("Launch plan").getUnclippedBoundsInRoot().bottom
        assertEquals(26.dp, firstArtifactHeading.getUnclippedBoundsInRoot().top - chatBottom)
    }

    @Test
    fun unavailableResultsReplaceTheSkeletonAndPreserveSearchConditions() {
        val search = ChatSearchState(TextFieldValue("Missing"))
        var chats by mutableStateOf(ChatListUiState(listPhase = ChatReadPhase.Loading))
        var remote by
            mutableStateOf(
                WorkspaceSearchResults(
                    "Missing",
                    messages = SearchRead.Failed,
                    artifacts = SearchRead.Failed,
                ),
            )
        var workflows by mutableStateOf<SearchRead<SearchWorkflowHit>>(SearchRead.Failed)
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
                    workflowResults = workflows,
                    onOpenWorkflow = {},
                    onOpenArtifact = {},
                )
            }
        }

        val failure = compose.onNodeWithText("Temporarily unable to load")
        val partial = compose.onNodeWithTag("chat_search_feedback")
        val all = compose.onNodeWithTag("search_type_All")
        val query = compose.onNodeWithTag("chat_search_query")
        compose.mainClock.advanceTimeBy(280)
        compose.onNodeWithContentDescription("Loading chats…").assertIsDisplayed()
        failure.assertDoesNotExist()

        compose.runOnIdle {
            chats = ChatListUiState(listReadFailure = ChatListReadFailure.NeedsRetry)
        }
        failure.assertIsDisplayed()
        compose.onNodeWithContentDescription("Loading chats…").assertDoesNotExist()
        partial.assertDoesNotExist()

        compose.runOnIdle { chats = ChatListUiState(confirmedAt = 1) }
        failure.assertIsDisplayed()
        compose.onNodeWithText("No matching results").assertDoesNotExist()
        all.assertIsSelected()
        query.assertTextContains("Missing")

        compose.onNodeWithTag("search_type_Chats").performClick()
        compose.runOnIdle {
            chats = chats.copy(listReadFailure = ChatListReadFailure.NeedsRetry)
        }
        compose.onNodeWithText("No matching chats").assertIsDisplayed()
        partial.assertIsDisplayed()
        failure.assertDoesNotExist()
        compose.runOnIdle {
            chats = chats.copy(listReadFailure = null)
            remote =
                WorkspaceSearchResults(
                    "Missing",
                    messages = SearchRead.Ready(emptyList()),
                    artifacts = SearchRead.Ready(emptyList()),
                )
        }
        compose.onNodeWithText("No matching chats").assertIsDisplayed()
        partial.assertDoesNotExist()
        compose.runOnIdle { workflows = SearchRead.Ready(emptyList()) }
        all.performClick()
        compose.onNodeWithText("No matching results").assertIsDisplayed()
        query.assertTextContains("Missing")

        compose.onNodeWithTag("search_type_Messages").performClick()
        val emptyMessages = compose.onNodeWithText("No matching messages")
        val progress = compose.onNodeWithContentDescription("Searching…")
        compose.runOnIdle {
            remote =
                remote.copy(
                    messages = SearchRead.Ready(emptyList(), refresh = SearchRefresh.Scheduled),
                )
        }
        compose.mainClock.advanceTimeBy(320)
        emptyMessages.assertIsDisplayed()
        progress.assertDoesNotExist()
        compose.runOnIdle {
            remote =
                remote.copy(
                    messages = SearchRead.Ready(emptyList(), refresh = SearchRefresh.Reading),
                )
        }
        emptyMessages.assertIsDisplayed()
        compose.mainClock.advanceTimeBy(280)
        progress.assertIsDisplayed()
        compose.runOnIdle {
            remote =
                remote.copy(
                    messages = SearchRead.Ready(emptyList(), refresh = SearchRefresh.Failed),
                )
        }
        emptyMessages.assertIsDisplayed()
        partial.assertIsDisplayed()
        progress.assertDoesNotExist()

        compose.onNodeWithTag("search_type_Chats").performClick()
        partial.assertDoesNotExist()
        compose.onNodeWithTag("search_type_Messages").performClick()
        partial.assertIsDisplayed()

        compose.runOnIdle { remote = remote.copy(messages = SearchRead.Ready(emptyList())) }
        partial.assertDoesNotExist()
        compose.runOnIdle {
            remote =
                remote.copy(
                    messages = SearchRead.Ready(emptyList(), refresh = SearchRefresh.Failed),
                )
        }
        emptyMessages.assertIsDisplayed()
        partial.assertIsDisplayed()
    }

    @Test
    fun coldRemoteReadSkipsFeedbackWhenTheResponseIsFast() {
        val search = ChatSearchState(TextFieldValue("Launch"), type = WorkspaceSearchType.Messages)
        var messages by mutableStateOf<SearchRead<SearchMessageHit>>(SearchRead.Scheduled)
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
                    remote = WorkspaceSearchResults(search.keyword, messages),
                )
            }
        }

        val skeleton = compose.onNodeWithContentDescription("Searching…")
        val empty = compose.onNodeWithText("No matching messages")
        compose.mainClock.advanceTimeBy(320)
        skeleton.assertDoesNotExist()
        empty.assertDoesNotExist()

        compose.runOnIdle { messages = SearchRead.Loading }
        compose.mainClock.advanceTimeBy(96)
        skeleton.assertDoesNotExist()
        compose.runOnIdle { messages = SearchRead.Ready(emptyList()) }
        empty.assertIsDisplayed()
        compose.mainClock.advanceTimeBy(280)
        skeleton.assertDoesNotExist()

        compose.runOnIdle {
            search.edit(TextFieldValue("Later"))
            messages = SearchRead.Loading
        }
        skeleton.assertDoesNotExist()
        empty.assertDoesNotExist()
        compose.mainClock.advanceTimeBy(280)
        skeleton.assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w320dp-h400dp")
    fun unavailableStatusCanWrapAndScrollInAShortViewportAtLargeFontScale() {
        val search = ChatSearchState(TextFieldValue("Launch"), type = WorkspaceSearchType.Messages)
        var height by mutableStateOf(360.dp)
        compose.setContent {
            OkouTheme(false) {
                CompositionLocalProvider(
                    LocalDensity provides Density(LocalDensity.current.density, fontScale = 2f),
                ) {
                    Box(Modifier.height(height)) {
                        WorkspaceSearchScreen(
                            state = ChatListUiState(),
                            search = search,
                            widthDp = 320,
                            listWidth = null,
                            focusOnEntry = false,
                            onFocused = {},
                            onClose = {},
                            onOpen = {},
                            remote = WorkspaceSearchResults("Launch", messages = SearchRead.Failed),
                        )
                    }
                }
            }
        }

        val label = compose.onNodeWithText("Temporarily unable to load").assertIsDisplayed()
        val fullLabelHeight = label.getUnclippedBoundsInRoot().let { it.bottom - it.top }
        compose.runOnIdle { height = 180.dp }

        val results = compose.onNodeWithTag("chat_search_results")
        val shortLabel = label.getUnclippedBoundsInRoot()
        assertEquals(fullLabelHeight, shortLabel.bottom - shortLabel.top)
        val viewportBottom = results.getUnclippedBoundsInRoot().bottom
        assertTrue(shortLabel.bottom > viewportBottom)
        results.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 160f) }
        assertTrue(label.getUnclippedBoundsInRoot().bottom < viewportBottom)
    }

    @Test
    fun partialFailureOverlaysResultsOnceAndWaitsForPendingSources() {
        val date = "2026-11-13T00:00:00Z"
        val chat =
            ConfirmedChat(
                id = "chat",
                title = "Launch plan",
                sortAt = date,
                createdAt = date,
                updatedAt = date,
                pinnedAt = null,
                archived = false,
                renamedAt = null,
            )
        val search = ChatSearchState(TextFieldValue("Launch"))
        var visible by mutableStateOf(true)
        var messages by mutableStateOf<SearchRead<SearchMessageHit>>(SearchRead.Scheduled)
        var artifacts by mutableStateOf<SearchRead<SearchArtifactHit>>(SearchRead.Failed)
        compose.setContent {
            OkouTheme(false) {
                if (visible) {
                    WorkspaceSearchScreen(
                        state = ChatListUiState(confirmedAt = 1, threadsByRecency = listOf(chat)),
                        search = search,
                        widthDp = 400,
                        listWidth = null,
                        focusOnEntry = false,
                        onFocused = {},
                        onClose = {},
                        onOpen = {},
                        remote = WorkspaceSearchResults("Launch", messages, artifacts),
                        workflowResults = SearchRead.Ready(emptyList()),
                        onOpenWorkflow = {},
                        onOpenArtifact = {},
                    )
                }
            }
        }

        val partial = compose.onNodeWithText("Some search results are temporarily unavailable")
        val progress = compose.onNodeWithContentDescription("Searching…")
        val row = compose.onNodeWithText("Launch plan")
        val rowBounds = row.getUnclippedBoundsInRoot()
        val viewport = compose.onNodeWithTag("chat_search_results")
        val viewportBounds = viewport.getUnclippedBoundsInRoot()
        compose.mainClock.advanceTimeBy(320)
        progress.assertDoesNotExist()
        partial.assertDoesNotExist()
        compose.runOnIdle { messages = SearchRead.Loading }
        progress.assertDoesNotExist()
        compose.mainClock.advanceTimeBy(160)
        progress.assertDoesNotExist()
        compose.runOnIdle { messages = SearchRead.Retrying }
        compose.mainClock.advanceTimeBy(160)
        progress.assertIsDisplayed()
        partial.assertDoesNotExist()

        compose.runOnIdle {
            messages = SearchRead.Failed
            artifacts = SearchRead.Scheduled
        }
        progress.assertIsDisplayed()
        partial.assertDoesNotExist()
        compose.runOnIdle { artifacts = SearchRead.Failed }
        partial.assertIsDisplayed()
        progress.assertDoesNotExist()
        assertEquals(rowBounds, row.getUnclippedBoundsInRoot())
        assertEquals(viewportBounds, viewport.getUnclippedBoundsInRoot())
        assertTrue(partial.getUnclippedBoundsInRoot().top > rowBounds.bottom)
        compose.onNodeWithTag("search_type_All").assertIsSelected()
        compose.onNodeWithTag("chat_search_query").assertTextContains("Launch")

        compose.mainClock.advanceTimeBy(5_300)
        partial.assertDoesNotExist()
        compose.runOnIdle { visible = false }
        compose.onNodeWithTag("chat_search").assertDoesNotExist()
        compose.runOnIdle { visible = true }
        row.assertIsDisplayed()
        partial.assertDoesNotExist()

        compose.runOnIdle {
            messages = SearchRead.Ready(emptyList())
            artifacts = SearchRead.Ready(emptyList())
        }
        partial.assertDoesNotExist()
        compose.runOnIdle { artifacts = SearchRead.Failed }
        partial.assertIsDisplayed()
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun searchProgressKeepsItsPaletteColorsAndSemanticsWithReducedMotion() {
        val search = ChatSearchState(TextFieldValue("Launch"))
        var dark by mutableStateOf(false)
        compose.runOnIdle { animationScale.floatValue = 0f }
        compose.setContent {
            OkouTheme(
                dark = dark,
                palette =
                    if (dark) UserPreferencesColorTheme.BLUE_HORIZON
                    else UserPreferencesColorTheme.DEFAULT,
            ) {
                WorkspaceSearchScreen(
                    state = ChatListUiState(confirmedAt = 1),
                    search = search,
                    widthDp = 400,
                    listWidth = null,
                    focusOnEntry = false,
                    onFocused = {},
                    onClose = {},
                    onOpen = {},
                    remote =
                        WorkspaceSearchResults(
                            "Launch",
                            messages = SearchRead.Retrying,
                            artifacts =
                                SearchRead.Ready(
                                    listOf(
                                        SearchArtifactHit(
                                            "file",
                                            "Launch brief",
                                            ArtifactKind.File,
                                        ),
                                    ),
                                ),
                        ),
                    onOpenArtifact = {},
                )
            }
        }

        val progress = compose.onNodeWithContentDescription("Searching…")
        compose.mainClock.advanceTimeBy(280)
        progress.assert(
            SemanticsMatcher.expectValue(
                SemanticsProperties.ProgressBarRangeInfo,
                ProgressBarRangeInfo.Indeterminate,
            ),
        )
        val bounds = progress.getUnclippedBoundsInRoot()
        assertEquals(4.dp, bounds.bottom - bounds.top)

        fun colors(): List<Int> {
            val pixels = progress.captureToImage().toPixelMap()
            val centerY = pixels.height / 2
            return listOf(
                pixels[pixels.width / 8, centerY].toArgb(),
                pixels[pixels.width * 7 / 8, centerY].toArgb(),
            )
        }
        fun assertColors(palette: UserPreferencesColorTheme, dark: Boolean) {
            val (active, track) = colors()
            val expected = resolvePalette(palette, dark)
            assertEquals(expected.primary.toArgb(), active)
            val expectedTrack = expected.secondaryContainer.toArgb()
            // Allow one sRGB level for the native compositor's 8-bit rounding.
            for (shift in listOf(16, 8, 0)) {
                val expected = (expectedTrack shr shift) and 0xFF
                val actual = (track shr shift) and 0xFF
                assertTrue(
                    "Track channel at $shift: expected $expected, got $actual",
                    abs(expected - actual) <= 1,
                )
            }
        }
        assertColors(UserPreferencesColorTheme.DEFAULT, dark = false)
        val light = colors()
        compose.mainClock.advanceTimeBy(600)
        assertEquals(light, colors())
        compose.runOnIdle { dark = true }
        assertColors(UserPreferencesColorTheme.BLUE_HORIZON, dark = true)
        assertEquals(bounds, progress.getUnclippedBoundsInRoot())
    }
}
