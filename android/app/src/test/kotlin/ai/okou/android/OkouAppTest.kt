package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatListRoute
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
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.CompletableDeferred
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp")
class OkouAppTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val owners = ViewModelStore()
    private var background: Color? = null
    private val deviceConfiguration = mutableStateOf<Configuration?>(null)

    private fun render(
        store: TestPreferencesStore = TestPreferencesStore(),
        fontScale: Float = 1f,
        withWorkspacePreferences: Boolean = false,
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
                            initializer { AppearanceModel(store) }
                            initializer {
                                MemberPreferencesModel(
                                    testBootstrap().preferences,
                                    (compose.activity.application as TestOkouApplication)
                                        .createWorkspaceSession(
                                            WorkspaceIdentity(
                                                "https://api.okou.ai",
                                                "font-user",
                                                "font-session",
                                                "font-org",
                                            ),
                                            WorkspaceTokenProvider { "test-token" },
                                        ),
                                    { true },
                                    {},
                                )
                            }
                        },
                    )
                Triple(
                    provider[ChatListModel::class.java].apply { refresh() },
                    provider[AppearanceModel::class.java],
                    if (withWorkspacePreferences) provider[MemberPreferencesModel::class.java]
                    else null,
                )
            }
        compose.setContent {
            val state by models.second.uiState.collectAsStateWithLifecycle()
            CompositionLocalProvider(
                LocalConfiguration provides
                    (deviceConfiguration.value ?: LocalConfiguration.current),
                LocalDensity provides Density(LocalDensity.current.density, fontScale),
            ) {
                OkouTheme(state.mode.resolveDark(isSystemInDarkTheme())) {
                    val color = MaterialTheme.colorScheme.background
                    SideEffect { background = color }
                    OkouApp(
                        state,
                        models.second::selectMode,
                        models.second::retry,
                        workspacePreferences = {
                            models.third?.let { MemberPreferencesSettings(it) }
                        },
                        homeContent = { ChatListRoute(models.first) },
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
    fun workspaceLanguageChoicesRemainReachableWithLargeText() {
        render(fontScale = 2f, withWorkspacePreferences = true)
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("English").performScrollTo().performClick()
        compose.onNodeWithText("繁體中文").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun chatFilterSurvivesAvatarNavigationAndBack() {
        render()
        compose.onNodeWithText("Chats").assertExists()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Appearance").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("Archived").assertIsSelected()
    }

    @Test
    fun homeIsUsableBeforeAppearanceStorageReturns() {
        render(TestPreferencesStore().apply { initialRead = CompletableDeferred() })
        compose.onNodeWithText("Chats").assertExists()
        compose.onNodeWithText("Archived").performClick().assertIsSelected()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Loading appearance…").assertExists()
        compose.onNodeWithText("Dark").assertIsNotEnabled()
    }

    @Test
    fun preferenceFailuresAreVisibleAndRetryRestoresNativeSelection() {
        val storage = TestPreferencesStore().apply { readFailure = true }
        render(storage)
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Could not load appearance. Try again.").assertExists()
        compose.onNodeWithText("Light").assertIsNotEnabled()
        compose.runOnIdle { storage.readFailure = false }
        compose.onNodeWithText("Try again").performScrollTo().performClick()
        compose.onNodeWithText("Light").assertIsEnabled()
        compose.runOnIdle { storage.writeFailure = true }
        compose.onNodeWithText("Dark").performClick()
        compose.onNodeWithText("Could not save appearance. Try again.").assertExists()
        compose.onNodeWithText("Follow system").assertIsSelected()
        compose.runOnIdle { storage.writeFailure = false }
        compose.onNodeWithText("Try again").performScrollTo().performClick()
        compose.onNodeWithText("Dark").assertIsSelected()
        compose.onNodeWithText("Light").performClick()
        compose.onNodeWithText("Light").assertIsSelected()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp-notnight")
    fun manualAppearanceAndLiveSystemChangesRetainTheActiveDestination() {
        render()
        val light = compose.runOnIdle { background }
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Dark").performClick()
        compose.onNodeWithText("Dark").assertIsSelected()
        compose.runOnIdle { org.junit.Assert.assertNotEquals(light, background) }
        compose.onNodeWithText("Follow system").performClick()
        compose.runOnIdle { assertEquals(light, background) }
        compose.runOnIdle {
            deviceConfiguration.value =
                Configuration(compose.activity.resources.configuration).apply {
                    uiMode =
                        (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                            Configuration.UI_MODE_NIGHT_YES
                }
        }
        compose.onNodeWithText("Follow system").assertIsSelected()
        compose.runOnIdle { org.junit.Assert.assertNotEquals(light, background) }
        compose.onNodeWithText("Light").performClick()
        compose.runOnIdle { assertEquals(light, background) }
        compose.onNodeWithText("Follow system").performClick()
        compose.runOnIdle { org.junit.Assert.assertNotEquals(light, background) }
    }

    @Test
    @Config(qualifiers = "en-rUS-w900dp-h900dp")
    fun expandedWindowRetainsAvatarAndConversationDestinations() {
        render()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Follow system").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("Chats").assertExists()
    }

    @Test
    @Config(qualifiers = "de-rDE-w400dp-h800dp")
    fun longLocalizedLabelsRemainOperableAtLargeFontScale() {
        render(fontScale = 2f)
        compose.onNodeWithContentDescription("Einstellungen").assertIsDisplayed().performClick()
        compose.onNodeWithText("Dunkel").performScrollTo().assertIsDisplayed().performClick()
        compose.onNodeWithText("Dunkel").assertIsSelected()
        compose.onNodeWithText("Auf diesem Gerät").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Zurück").assertIsDisplayed().performClick()
        compose.onNodeWithText("Chats").assertIsDisplayed()
        compose.onNodeWithText("Chats aktualisieren").assertIsDisplayed().performClick()
    }
}
