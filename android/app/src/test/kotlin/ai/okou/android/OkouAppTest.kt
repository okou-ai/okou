package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.chat.ChatComposerModel
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatListService
import ai.okou.android.chat.RunControlsModel
import ai.okou.android.preferences.MemberPreferencesModel
import ai.okou.android.preferences.MemberPreferencesSettings
import ai.okou.android.updates.UpdateTransfer
import ai.okou.android.updates.UpdateUiState
import ai.okou.android.updates.updateRelease
import ai.okou.android.updates.updateToolbarAction
import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.WindowInfo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.isSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.text.NumberFormat
import java.util.Locale
import kotlinx.coroutines.CompletableDeferred
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp")
class OkouAppTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val owners = ViewModelStore()
    private var background: Color? = null
    private val deviceConfiguration = mutableStateOf<Configuration?>(null)
    private val windowSize = mutableStateOf<IntSize?>(null)
    private val contentHeight = mutableStateOf(Dp.Infinity)
    private val release = updateRelease("99.0.0")
    private val availableUpdate =
        UpdateUiState(
            installedVersion = "0.31.0",
            info = AndroidUpdates(null, release),
            transfer = UpdateTransfer.Idle,
            sdk = 35,
        )

    private fun render(
        fontScale: Float = 1f,
        updateState: () -> UpdateUiState? = { null },
        failPreferenceSave: () -> Boolean = { false },
        chatService: ChatListService = TestChatService(),
        inputModeManager: InputModeManager? = null,
    ) {
        val models =
            compose.runOnIdle {
                val provider =
                    ViewModelProvider(
                        owners,
                        viewModelFactory {
                            initializer {
                                ChatListModel(
                                    chatService,
                                    (compose.activity.application as TestOkouApplication).chatCache,
                                    WorkspaceIdentity(
                                        "https://api.okou.ai",
                                        "shell-user",
                                        "shell-session",
                                        "shell-org",
                                    ),
                                    { true },
                                    {},
                                )
                            }
                            initializer {
                                val app = compose.activity.application as TestOkouApplication
                                ChatComposerModel(
                                    TestChatComposerService(),
                                    app.composerJournal,
                                    WorkspaceIdentity(
                                        "https://api.okou.ai",
                                        "shell-user",
                                        "shell-session",
                                        "shell-org",
                                    ),
                                    { true },
                                    {},
                                    {},
                                )
                            }
                            initializer {
                                val service =
                                    (compose.activity.application as TestOkouApplication)
                                        .createWorkspaceSession(
                                            WorkspaceIdentity(
                                                "https://api.okou.ai",
                                                "font-user",
                                                "font-session",
                                                "font-org",
                                            ),
                                            WorkspaceTokenProvider { "test-token" },
                                        )
                                MemberPreferencesModel(
                                    testPreferences(),
                                    object : WorkspaceSession by service {
                                        override suspend fun updatePreferences(
                                            update: UpdatePreferencesRequest
                                        ): UserPreferences {
                                            if (failPreferenceSave())
                                                throw ai.okou.android.api.ApiFailure.Http(
                                                    400,
                                                    null,
                                                    null,
                                                    null,
                                                )
                                            return service.updatePreferences(update)
                                        }
                                    },
                                    { true },
                                    {},
                                )
                            }
                        },
                    )
                Pair(
                    provider[ChatListModel::class.java].apply { refresh() } to
                        provider[ChatComposerModel::class.java],
                    provider[MemberPreferencesModel::class.java],
                )
            }
        val controls =
            compose.runOnIdle {
                ViewModelProvider(
                    owners,
                    viewModelFactory {
                        initializer {
                            val app = compose.activity.application as TestOkouApplication
                            val identity =
                                WorkspaceIdentity(
                                    "https://api.okou.ai",
                                    "shell-user",
                                    "shell-session",
                                    "shell-org",
                                )
                            RunControlsModel(
                                app.createWorkspaceSession(
                                    identity,
                                    WorkspaceTokenProvider { "test-token" },
                                ),
                                app.runControlJournal,
                                identity,
                                models.first.first.history,
                                { true },
                                {},
                            )
                        }
                    },
                )[RunControlsModel::class.java]
            }
        compose.setContent {
            val state by models.second.uiState.collectAsStateWithLifecycle()
            val window = LocalWindowInfo.current
            CompositionLocalProvider(
                LocalConfiguration provides
                    (deviceConfiguration.value ?: LocalConfiguration.current),
                LocalDensity provides Density(LocalDensity.current.density, fontScale),
                LocalInputModeManager provides (inputModeManager ?: LocalInputModeManager.current),
                LocalWindowInfo provides
                    object : WindowInfo by window {
                        override val containerSize: IntSize
                            get() = windowSize.value ?: window.containerSize
                    },
            ) {
                val dark = state.theme.resolveDark(isSystemInDarkTheme())
                OkouTheme(dark) {
                    val color = MaterialTheme.colorScheme.background
                    SideEffect { background = color }
                    Box {
                        Box(Modifier.heightIn(max = contentHeight.value)) {
                            OkouApp(
                                models.first.first,
                                models.first.second,
                                controls,
                                projectExpansion = null,
                                settingsContent = { _, _, _ ->
                                    SettingsScreen(
                                        workspacePreferences = {
                                            MemberPreferencesSettings(models.second)
                                        }
                                    )
                                },
                                updateToolbarAction =
                                    updateState()?.let {
                                        updateToolbarAction(
                                            it,
                                            download = {},
                                            install = {},
                                            installProgress = null,
                                            openDetails = {},
                                        )
                                    },
                            )
                        }
                    }
                }
            }
        }
    }

    @After
    fun clearOwners() {
        compose.runOnIdle { owners.clear() }
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun updateToolbarKeepsThePercentageReadableWithLargerText() {
        val percent = "50%"
        render(
            fontScale = 2f,
            updateState = {
                availableUpdate.copy(
                    transfer = UpdateTransfer.Downloading(release, release.size / 2)
                )
            },
        )
        val layouts = mutableListOf<TextLayoutResult>()
        val action =
            compose
                .onNodeWithContentDescription(
                    compose.activity.getString(R.string.updates_downloading, percent)
                )
                .assertWidthIsEqualTo(48.dp)
        val bounds = action.getUnclippedBoundsInRoot()
        assertTrue(bounds.bottom - bounds.top >= 48.dp)
        compose.onNodeWithText(percent, useUnmergedTree = true).performSemanticsAction(
            SemanticsActions.GetTextLayoutResult
        ) {
            it(layouts)
        }
        val layout = layouts.single()
        assertEquals(1, layout.lineCount)
        assertEquals(percent.length, layout.getLineEnd(0, visibleEnd = true))
        assertFalse(layout.didOverflowHeight || layout.isLineEllipsized(0))
        assertTrue(
            "Progress glyphs at ${layout.getLineLeft(0)}..${layout.getLineRight(0)} exceed ${layout.size.width}px",
            layout.getLineLeft(0) >= -1f && layout.getLineRight(0) <= layout.size.width + 1f,
        )
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "de-rDE-w320dp-h640dp-420dpi")
    fun updateToolbarKeepsItsBoundsAcrossLocalizedActionsWithLargeText() {
        val update = mutableStateOf(availableUpdate.copy(transfer = UpdateTransfer.Failed))
        render(fontScale = 2f, updateState = { update.value })
        val retry =
            compose
                .onNodeWithContentDescription(
                    compose.activity.getString(R.string.updates_retry_download)
                )
                .assertIsDisplayed()
        val actionBounds = retry.getUnclippedBoundsInRoot()
        val listBounds = compose.onNodeWithTag("chat_list").getUnclippedBoundsInRoot()
        val percent = NumberFormat.getPercentInstance(Locale.GERMANY).format(0.5)
        listOf(
                UpdateTransfer.Idle to compose.activity.getString(R.string.updates_toolbar),
                UpdateTransfer.Downloading(release) to
                    compose.activity.getString(R.string.updates_preparing),
                UpdateTransfer.Downloading(release, release.size / 2) to
                    compose.activity.getString(R.string.updates_downloading, percent),
                UpdateTransfer.Ready(release) to compose.activity.getString(R.string.updates_ready),
            )
            .forEach { (transfer, label) ->
                compose.runOnIdle { update.value = availableUpdate.copy(transfer = transfer) }
                val action = compose.onNodeWithContentDescription(label).assertIsDisplayed()
                assertEquals(actionBounds, action.getUnclippedBoundsInRoot())
                assertEquals(
                    listBounds,
                    compose.onNodeWithTag("chat_list").getUnclippedBoundsInRoot(),
                )
            }
    }

    @Test
    fun workspaceLanguageChoicesRemainReachableWithLargeText() {
        render(fontScale = 2f)
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Language").performScrollTo().performClick()
        compose.onNodeWithText("繁體中文").performScrollTo().assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w240dp-h450dp")
    fun compactSettingsShowTheValueBelowTheTitle() {
        render()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Display mode").performScrollTo().assertIsDisplayed()
        val title = compose.onNodeWithText("Display mode", useUnmergedTree = true)
        val value = compose.onNodeWithText("Follow system", useUnmergedTree = true)
        assertTrue(
            value.assertIsDisplayed().getUnclippedBoundsInRoot().top >=
                title.getUnclippedBoundsInRoot().bottom
        )
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun chatFilterSurvivesSettingsAndBack() {
        render()
        compose.onNodeWithContentDescription("Chats").assertExists()
        compose.onNodeWithContentDescription("More actions").assertDoesNotExist()
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Inbox").assertIsSelected().assertHeightIsEqualTo(48.dp)
        compose
            .onNodeWithTag("workspace_popup")
            .assertWidthIsEqualTo(244.dp)
            .assertHeightIsEqualTo(265.dp)
        compose.onNodeWithText("Mark all as read").assertIsNotEnabled()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Display mode").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("chat_filter_heading").assertIsDisplayed().assert(hasText("Archived"))
        compose.onNodeWithText("New chat").assertIsDisplayed()
        compose
            .onNodeWithContentDescription("Filter")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Archived"))
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNode(hasText("Archived").and(isSelected())).assertIsDisplayed()
        compose.onNodeWithText("Inbox").performClick()
        compose.onNodeWithTag("chat_filter_heading").assertDoesNotExist()
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun updateOverflowOpensTheSameFilterMenu() {
        render(updateState = { availableUpdate })
        compose.onNodeWithContentDescription("More actions").performClick()
        compose
            .onNodeWithTag("workspace_popup")
            .assertWidthIsEqualTo(244.dp)
            .assertHeightIsEqualTo(110.dp)
        compose.onNodeWithText("Filter").performClick()
        compose.onNodeWithText("Inbox").assertIsSelected()
        compose.onNodeWithText("Mark all as read").assertIsNotEnabled()
        compose.onNodeWithText("Muted").performClick()
        compose.onNodeWithTag("chat_filter_heading").assertIsDisplayed().assert(hasText("Muted"))
        compose
            .onNodeWithContentDescription("More actions")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Muted"))
        compose.onNodeWithContentDescription("More actions").performClick()
        compose.onNodeWithText("Filter").performClick()
        compose.onNode(hasText("Muted").and(isSelected())).assertIsDisplayed()
        compose.onNodeWithText("Inbox").performClick()
        compose.onNodeWithTag("chat_filter_heading").assertDoesNotExist()
    }

    @Test
    fun preferenceFailuresAreVisibleAndRetryRestoresNativeSelection() {
        var fail = true
        render(failPreferenceSave = { fail })
        compose.onNodeWithContentDescription("Settings").performClick()
        selectAppearance("Dark")
        compose
            .onNodeWithText("Could not save your preferences. Your selections are still in use.")
            .assertExists()
        compose.onNodeWithText("Dark").assertIsDisplayed()
        compose.runOnIdle { fail = false }
        compose.onNodeWithText("Try again").performScrollTo().performClick()
        compose.onNodeWithText("Display mode").performClick()
        compose.onNode(isSelectable() and hasText("Dark")).assertIsSelected()
        compose
            .onNode(isSelectable() and hasText("Light"))
            .performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithText("Light").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp-notnight")
    fun manualAppearanceAndLiveSystemChangesRetainTheActiveDestination() {
        render()
        val light = compose.runOnIdle { background }
        compose.onNodeWithContentDescription("Settings").performClick()
        selectAppearance("Dark")
        compose.onNodeWithText("Dark").assertIsDisplayed()
        compose.runOnIdle { org.junit.Assert.assertNotEquals(light, background) }
        selectAppearance("Follow system")
        compose.runOnIdle { assertEquals(light, background) }
        compose.runOnIdle {
            deviceConfiguration.value =
                Configuration(compose.activity.resources.configuration).apply {
                    uiMode =
                        (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                            Configuration.UI_MODE_NIGHT_YES
                }
        }
        compose.onNodeWithText("Follow system").assertIsDisplayed()
        compose.runOnIdle { org.junit.Assert.assertNotEquals(light, background) }
        selectAppearance("Light")
        compose.runOnIdle { assertEquals(light, background) }
        selectAppearance("Follow system")
        compose.runOnIdle { org.junit.Assert.assertNotEquals(light, background) }
    }

    private fun selectAppearance(mode: String, row: String = "Display mode") {
        compose.onNodeWithText(row).performScrollTo().performClick()
        compose
            .onNode(isSelectable() and hasText(mode))
            .performScrollTo()
            .assertIsDisplayed()
            .performSemanticsAction(SemanticsActions.OnClick)
    }

    @Test
    @Config(qualifiers = "en-rUS-w900dp-h900dp")
    fun expandedWindowShowsOneListAndAnUnselectedPaneUntilTheWindowShrinks() {
        render()
        compose.onNodeWithTag("chat_list").assertExists()
        compose.onNodeWithTag("workspace_new_chat").assertExists()
        compose.onNodeWithTag("conversation").assertDoesNotExist()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Follow system").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("workspace_new_chat").assertExists()
        compose.runOnIdle {
            deviceConfiguration.value =
                Configuration(compose.activity.resources.configuration).apply {
                    screenHeightDp = 479
                }
        }
        compose.onNodeWithTag("workspace_new_chat").assertExists()
        compose.runOnIdle {
            val density = compose.activity.resources.displayMetrics.density
            windowSize.value = IntSize((900 * density).toInt(), (479 * density).toInt())
        }
        compose.onNodeWithTag("chat_list").assertExists()
        compose.onNodeWithTag("workspace_new_chat").assertDoesNotExist()
        compose.runOnIdle { windowSize.value = null }
        compose.onNodeWithTag("workspace_new_chat").assertExists()
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun shortNewChatEditorKeepsTheDraftAndSelectionWhenResized() {
        render()
        compose.onNodeWithText("New chat").performClick()
        val input = compose.onNodeWithTag("message_input").assertIsDisplayed().assertIsEnabled()
        fun resize(heightDp: Int) =
            compose.runOnIdle {
                val density = compose.activity.resources.displayMetrics.density
                windowSize.value = IntSize((400 * density).toInt(), (heightDp * density).toInt())
            }
        val draft = (1..20).joinToString("\n") { "Draft line $it" }
        val selection = TextRange(12)
        fun assertDraftAndSelection() {
            val semantics = input.fetchSemanticsNode().config
            assertEquals(draft, semantics[SemanticsProperties.EditableText].text)
            assertEquals(selection, semantics[SemanticsProperties.TextSelectionRange])
        }

        input.performTextReplacement(draft)
        input.performTextInputSelection(selection)
        input.assertHeightIsEqualTo(160.dp)

        resize(479)
        input.assertHeightIsEqualTo(48.dp)
        compose
            .onNodeWithContentDescription("Send")
            .assertIsDisplayed()
            .assertWidthIsEqualTo(48.dp)
            .assertHeightIsEqualTo(48.dp)
        assertDraftAndSelection()

        resize(480)
        input.assertHeightIsEqualTo(144.dp)
        assertDraftAndSelection()

        resize(520)
        input.assertHeightIsEqualTo(156.dp)
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun shortNewChatEditorFitsOneLineAtLargeFontScale() {
        val density = compose.activity.resources.displayMetrics.density
        compose.runOnIdle {
            windowSize.value = IntSize((540 * density).toInt(), (320 * density).toInt())
        }
        render(fontScale = 2f)
        compose.onNodeWithText("New chat").performClick()
        val input = compose.onNodeWithTag("message_input").assertIsDisplayed()
        input.performTextReplacement("First line\nSecond line")

        val scaledLineHeight = with(Density(density, fontScale = 2f)) { 26.sp.toDp() }
        input.assertHeightIsEqualTo(scaledLineHeight + 16.dp)
        compose.onNodeWithContentDescription("Send").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h520dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun newChatKeepsSendAndRetryReachableWhenTheAvailableHeightShrinks() {
        val density = compose.activity.resources.displayMetrics.density
        compose.runOnIdle {
            windowSize.value = IntSize((400 * density).toInt(), (520 * density).toInt())
        }
        render(
            inputModeManager =
                object : InputModeManager {
                    override val inputMode = InputMode.Keyboard

                    override fun requestInputMode(inputMode: InputMode) =
                        this.inputMode == inputMode
                }
        )
        compose.onNodeWithText("New chat").performClick()
        val input = compose.onNodeWithTag("message_input").assertIsEnabled()
        val draft = (1..20).joinToString("\n") { "Draft line $it" }
        input.performTextReplacement(draft)
        input.performClick().assertIsFocused()
        input.assertHeightIsEqualTo(156.dp)

        // Model the space lost to the IME while the editor stays focused.
        for (height in listOf(300.dp, 270.dp, 240.dp, 210.dp)) {
            compose.runOnIdle { contentHeight.value = height }
        }

        val bounds = input.getUnclippedBoundsInRoot()
        val editorHeight = bounds.bottom - bounds.top
        assertTrue(editorHeight > 48.dp && editorHeight < 156.dp)
        val send =
            compose.onNodeWithContentDescription("Send").assertIsDisplayed().assertIsEnabled()
        send.assertHeightIsEqualTo(48.dp)
        val visible = send.fetchSemanticsNode().boundsInRoot
        assertEquals(48 * density, visible.height, 0.5f)
        assertEquals(
            draft,
            input
                .assertIsFocused()
                .fetchSemanticsNode()
                .config[SemanticsProperties.EditableText]
                .text,
        )
        // The fixture rejects thread creation, leaving the original command available to retry.
        send.performClick()
        val retry = compose.onNodeWithText("Retry this same message")
        retry.performScrollTo().assertIsDisplayed().assertIsEnabled()
    }

    @Test
    fun wideLayoutUsesTheWindowWidthAndMinimumHeight() {
        assertEquals(null, workspaceListPaneWidth(839, 900))
        assertEquals(null, workspaceListPaneWidth(1100, 479))
        assertEquals(320, workspaceListPaneWidth(840, 480))
        assertEquals(320, workspaceListPaneWidth(1099, 900))
        assertEquals(344, workspaceListPaneWidth(1100, 480))
    }

    @Test
    @Config(qualifiers = "de-rDE-w400dp-h800dp")
    fun longLocalizedLabelsRemainOperableAtLargeFontScale() {
        val initialListResponse = CompletableDeferred<Unit>()
        val chatService =
            object : TestChatService() {
                override suspend fun chatEvents(since: Long?): ChatEvents {
                    initialListResponse.await()
                    return super.chatEvents(since)
                }
            }
        render(fontScale = 2f, chatService = chatService)
        compose.onNodeWithContentDescription("Einstellungen").assertIsDisplayed().performClick()
        selectAppearance("Dunkel", row = "Anzeigemodus")
        compose.onNodeWithText("Dunkel").assertIsDisplayed()
        compose.onNodeWithText("Gemeinsame Einstellungen").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Zurück").assertIsDisplayed().performClick()
        compose.onNodeWithContentDescription("Chats").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(120)
        compose.onNodeWithContentDescription("Chats werden geladen…").assertIsDisplayed()
        initialListResponse.complete(Unit)

        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasContentDescription("Chats werden geladen…"))
                .fetchSemanticsNodes()
                .isEmpty()
        }
        compose.onNodeWithContentDescription("Filter").assertIsDisplayed().performClick()
        compose.onNodeWithText("Archiviert").assertIsDisplayed().performClick()
        compose
            .onNodeWithTag("chat_filter_heading")
            .assertIsDisplayed()
            .assert(hasText("Archiviert"))
    }
}
