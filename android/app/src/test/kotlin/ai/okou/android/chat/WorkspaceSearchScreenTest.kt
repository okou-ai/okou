package ai.okou.android.chat

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.artifacts.ArtifactKind
import ai.okou.android.state.ChatSearchState
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
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
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
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
        compose.onNodeWithContentDescription("View all Artifacts").performClick()
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
    fun allSearchWaitsForInitialChatsAndExplainsTheSavedScopeWhenThereIsNoMatch() {
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

        val genericFailure = compose.onNodeWithText("Couldn’t load search results")
        val savedScope = compose.onNodeWithText("Search is limited to saved chats. No matches.")
        val all = compose.onNodeWithTag("search_type_All")
        val query = compose.onNodeWithTag("chat_search_query")
        compose.mainClock.advanceTimeBy(280)
        compose.onNodeWithContentDescription("Loading chats…").assertIsDisplayed()
        genericFailure.assertDoesNotExist()

        compose.runOnIdle {
            chats = ChatListUiState(listReadFailure = ChatListReadFailure.NeedsRetry)
        }
        genericFailure.assertIsDisplayed()
        savedScope.assertDoesNotExist()

        compose.runOnIdle { chats = ChatListUiState(confirmedAt = 1) }
        savedScope.assertIsDisplayed()
        genericFailure.assertDoesNotExist()
        all.assertIsSelected()
        query.assertTextContains("Missing")

        compose.onNodeWithTag("search_type_Chats").performClick()
        compose.runOnIdle {
            chats = chats.copy(listReadFailure = ChatListReadFailure.NeedsRetry)
        }
        savedScope.assertIsDisplayed()
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
        savedScope.assertDoesNotExist()
        compose.runOnIdle { workflows = SearchRead.Ready(emptyList()) }
        all.performClick()
        compose.onNodeWithText("No matching results").assertIsDisplayed()
        query.assertTextContains("Missing")
    }

    @Test
    fun confirmedEmptyMessagesKeepThePartialNoticeAccurateWhenArtifactsFail() {
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
        var messages by mutableStateOf<SearchRead<SearchMessageHit>>(SearchRead.Failed)
        compose.setContent {
            OkouTheme(false) {
                WorkspaceSearchScreen(
                    state = ChatListUiState(confirmedAt = 1, threadsByRecency = listOf(chat)),
                    search = search,
                    widthDp = 400,
                    listWidth = null,
                    focusOnEntry = false,
                    onFocused = {},
                    onClose = {},
                    onOpen = {},
                    remote = WorkspaceSearchResults("Launch", messages, SearchRead.Failed),
                    workflowResults = SearchRead.Failed,
                    onOpenWorkflow = {},
                    onOpenArtifact = {},
                )
            }
        }

        val localOnly =
            compose.onNodeWithText("Some results couldn’t load. Showing saved chats only.")
        val partial = compose.onNodeWithText("Some results couldn’t load")
        localOnly.assertIsDisplayed()
        compose.onNodeWithText("Launch plan").assertIsDisplayed()

        compose.runOnIdle { messages = SearchRead.Ready(emptyList()) }
        partial.assertIsDisplayed()
        localOnly.assertDoesNotExist()
        compose.onNodeWithText("Launch plan").assertIsDisplayed()
        compose.onNodeWithTag("search_type_All").assertIsSelected()
        compose.onNodeWithTag("chat_search_query").assertTextContains("Launch")
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
        fun assertColors(expectedActive: Int, expectedTrack: Int) {
            val (active, track) = colors()
            assertEquals(expectedActive, active)
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
        assertColors(0xFFB5790C.toInt(), 0xFFF6EFE2.toInt())
        val light = colors()
        compose.mainClock.advanceTimeBy(600)
        assertEquals(light, colors())
        compose.runOnIdle { dark = true }
        assertColors(0xFF819EE0.toInt(), 0xFF2D323B.toInt())
        assertEquals(bounds, progress.getUnclippedBoundsInRoot())
    }
}
