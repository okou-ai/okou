package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.chat.ChatComposerModel
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.RunControlsModel
import ai.okou.android.preferences.MemberPreferencesModel
import ai.okou.android.preferences.MemberPreferencesSettings
import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.io.IOException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    private fun render(
        fontScale: Float = 1f,
        openUpdate: (() -> Unit)? = null,
        failPreferenceSave: () -> Boolean = { false },
    ) {
        val models =
            compose.runOnIdle {
                val provider =
                    ViewModelProvider(
                        owners,
                        viewModelFactory {
                            initializer {
                                ChatListModel(
                                    TestChatService(),
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
                                            if (failPreferenceSave()) throw IOException("offline")
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
            CompositionLocalProvider(
                LocalConfiguration provides
                    (deviceConfiguration.value ?: LocalConfiguration.current),
                LocalDensity provides Density(LocalDensity.current.density, fontScale),
            ) {
                val dark = state.theme.resolveDark(isSystemInDarkTheme())
                OkouTheme(dark) {
                    val color = MaterialTheme.colorScheme.background
                    SideEffect { background = color }
                    OkouApp(
                        models.first.first,
                        models.first.second,
                        controls,
                        settingsContent = { _, _ ->
                            SettingsScreen(
                                workspacePreferences = { MemberPreferencesSettings(models.second) }
                            )
                        },
                        openUpdate = openUpdate,
                    )
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
    fun updateToolbarKeepsTheLabelReadableWithLargerText() {
        render(fontScale = 1.3f, openUpdate = {})
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Update").assertWidthIsEqualTo(104.dp).assertHeightIsEqualTo(48.dp)
        compose.onNodeWithText("Update", useUnmergedTree = true).performSemanticsAction(
            SemanticsActions.GetTextLayoutResult
        ) {
            it(layouts)
        }
        assertFalse("Update action label was truncated", layouts.single().isLineEllipsized(0))
    }

    @Test
    fun workspaceLanguageChoicesRemainReachableWithLargeText() {
        render(fontScale = 2f)
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Language").performScrollTo().performClick()
        compose.onNodeWithText("繁體中文").performScrollTo().assertIsDisplayed()
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
        compose.onNodeWithText("Appearance").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("Archived").assertIsSelected().assertHeightIsEqualTo(48.dp)
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithText("Archived").assertDoesNotExist()
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun updateOverflowOpensTheSameFilterMenu() {
        render(openUpdate = {})
        compose.onNodeWithContentDescription("More actions").performClick()
        compose
            .onNodeWithTag("workspace_popup")
            .assertWidthIsEqualTo(244.dp)
            .assertHeightIsEqualTo(158.dp)
        compose.onNodeWithText("Filter").performClick()
        compose.onNodeWithText("Inbox").assertIsSelected()
        compose.onNodeWithText("Mark all as read").assertIsNotEnabled()
        compose.onNodeWithText("Muted").performClick()
        compose.onNodeWithText("Muted").assertIsSelected().performClick()
        compose.onNodeWithText("Muted").assertDoesNotExist()
    }

    @Test
    fun preferenceFailuresAreVisibleAndRetryRestoresNativeSelection() {
        var fail = true
        render(failPreferenceSave = { fail })
        compose.onNodeWithContentDescription("Settings").performClick()
        selectAppearance("Dark")
        compose.onNodeWithText("Could not confirm the save. Try again or refresh.").assertExists()
        compose.onNodeWithText("Dark").assertIsDisplayed()
        compose.onNodeWithText("Refresh preferences").assertExists()
        compose.runOnIdle { fail = false }
        compose.onNodeWithText("Try again").performScrollTo().performClick()
        compose.onNodeWithText("Appearance").performClick()
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

    private fun selectAppearance(mode: String, row: String = "Appearance") {
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
        compose.onNodeWithTag("chat_list").assertExists()
        compose.onNodeWithTag("workspace_new_chat").assertDoesNotExist()
        compose.runOnIdle { deviceConfiguration.value = null }
        compose.onNodeWithTag("workspace_new_chat").assertExists()
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
        render(fontScale = 2f)
        compose.onNodeWithContentDescription("Einstellungen").assertIsDisplayed().performClick()
        selectAppearance("Dunkel", row = "Erscheinungsbild")
        compose.onNodeWithText("Dunkel").assertIsDisplayed()
        compose.onNodeWithText("Arbeitsbereichseinstellungen").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Zurück").assertIsDisplayed().performClick()
        compose.onNodeWithContentDescription("Chats").assertIsDisplayed()
        val refresh =
            compose
                .onNodeWithTag("chat_list")
                .fetchSemanticsNode()
                .config[SemanticsActions.CustomActions]
                .single { it.label == "Chats aktualisieren" }
        compose.runOnIdle { assertEquals(true, refresh.action()) }
        compose.onNodeWithContentDescription("Filter").assertIsDisplayed().performClick()
        compose.onNodeWithText("Archiviert").assertIsDisplayed().performClick()
        compose.onNodeWithText("Archiviert").assertIsSelected()
    }
}
