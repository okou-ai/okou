package ai.okou.android

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
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextRange
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
    ) {
        val models =
            compose.runOnIdle {
                val provider =
                    ViewModelProvider(
                        owners,
                        viewModelFactory {
                            initializer { HomeModel() }
                            initializer { AppearanceModel(store) }
                        },
                    )
                provider[HomeModel::class.java] to provider[AppearanceModel::class.java]
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
                    OkouApp(models.first, state, models.second::selectMode, models.second::retry)
                }
            }
        }
    }

    @After
    fun clearOwners() {
        compose.runOnIdle { owners.clear() }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    fun localDraftPreviewAndNativeSelectionSurviveTabNavigationAndBack() {
        render()
        compose.onNodeWithTag("bottom_navigation").assertExists()
        compose.onNodeWithText("Preview draft").assertIsNotEnabled()
        compose.onNode(hasSetTextAction()).performTextInput("  Hello Okou\n你好 👋  ")
        compose.onNodeWithText("2 lines").assertExists()
        compose.onNodeWithText("Preview draft").performScrollTo().performClick()
        compose.onNode(hasText("  Hello Okou\n你好 👋  ") and !hasSetTextAction()).assertExists()
        compose.onNode(hasSetTextAction()).performTextInputSelection(TextRange(3))
        compose.onNodeWithText("Settings").performClick()
        compose.onNodeWithText("Appearance").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNode(hasSetTextAction()).assertTextContains("  Hello Okou\n你好 👋  ")
        compose
            .onNode(hasSetTextAction())
            .assert(
                SemanticsMatcher.expectValue(SemanticsProperties.TextSelectionRange, TextRange(3))
            )
        compose.onNode(hasSetTextAction()).performTextReplacement("   ")
        compose.onNodeWithText("Preview draft").assertIsNotEnabled()
        compose.onNode(hasText("  Hello Okou\n你好 👋  ") and !hasSetTextAction()).assertExists()
    }

    @Test
    fun homeIsUsableBeforeAppearanceStorageReturns() {
        render(TestPreferencesStore().apply { initialRead = CompletableDeferred() })
        compose.onNode(hasSetTextAction()).performTextInput("Ready without settings IO")
        compose.onNodeWithText("Preview draft").performScrollTo().performClick()
        compose.onNode(hasText("Ready without settings IO") and !hasSetTextAction()).assertExists()
        compose.onNodeWithText("Settings").performClick()
        compose.onNodeWithText("Loading appearance…").assertExists()
        compose.onNodeWithText("Dark").assertIsNotEnabled()
    }

    @Test
    fun preferenceFailuresAreVisibleAndRetryRestoresNativeSelection() {
        val storage = TestPreferencesStore().apply { readFailure = true }
        render(storage)
        compose.onNodeWithText("Settings").performClick()
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
        compose.onNodeWithText("Settings").performClick()
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
    fun expandedWindowUsesRailAndRetainsTheSameDestinations() {
        render()
        compose.onNodeWithTag("navigation_rail").assertExists()
        compose.onNodeWithText("Settings").performClick()
        compose.onNodeWithText("Follow system").assertExists()
        compose.onNodeWithText("Home").performClick()
        compose.onNode(hasSetTextAction()).assertExists()
    }

    @Test
    @Config(qualifiers = "de-rDE-w400dp-h800dp")
    fun longLocalizedLabelsRemainOperableAtLargeFontScale() {
        render(fontScale = 2f)
        compose.onNodeWithText("Einstellungen").assertIsDisplayed().performClick()
        compose.onNodeWithText("Dunkel").performScrollTo().assertIsDisplayed().performClick()
        compose.onNodeWithText("Dunkel").assertIsSelected()
        compose.onNodeWithText("Auf diesem Gerät").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Start").assertIsDisplayed().performClick()
        compose.onNode(hasSetTextAction()).performScrollTo().performTextInput("Große Schrift — 你好")
        compose
            .onNodeWithText("Entwurf ansehen")
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        compose.onNode(hasText("Große Schrift — 你好") and !hasSetTextAction()).assertExists()
    }
}
