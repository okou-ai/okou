package ai.okou.android.settings

import ai.okou.android.OkouTheme
import ai.okou.android.PaneFeedback
import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.api.ApiFailure
import ai.okou.android.auth.WorkspaceIdentity
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp")
class BuiltInToolsPageTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    @After
    fun closeOwner() {
        scope.cancel()
    }

    @Test
    fun cachedCatalogFailureKeepsItsRowAndClearsFeedbackOnExit() {
        val family = DataToolFamily("finance", mapOf("en-US" to "Financial data"))
        val fixture = ToolFixture()
        var now = 0L
        var fail = false
        val service =
            object : BuiltInToolsService by fixture {
                override suspend fun catalog(): List<DataToolFamily> {
                    if (fail) throw ApiFailure.Http(400, null, null, null)
                    return listOf(family)
                }
            }
        val model = render(service, nowMillis = { now })
        val row = compose.onNodeWithText("Financial data")
        row.assertIsEnabled()
        compose.runOnIdle {
            now += 600_001L
            fail = true
            model.refresh()
        }
        val failure = compose.onNodeWithText("Tools are temporarily unavailable.")
        failure.assertIsDisplayed()
        row.assertIsEnabled()
        compose.runOnIdle { model.hidePage() }
        failure.assertDoesNotExist()
    }

    @Test
    fun reenablingImageGenerationLeavesTheDismissedPickerClosed() {
        val service = ToolFixture()
        val model = render(service)
        val picker = compose.onNodeWithText("Image generation model")
        val firstModel = compose.onNode(hasText("GPT Image 1") and isSelectable())
        picker.assertIsEnabled().performClick()
        firstModel.assertIsDisplayed()

        compose.runOnIdle {
            service.imageEnabled = false
            model.refresh()
        }
        firstModel.assertDoesNotExist()
        picker.assertIsNotEnabled()

        compose.onNode(hasText("Image generation") and isToggleable()).performClick()
        firstModel.assertDoesNotExist()
        picker.assertIsEnabled().performClick()
        firstModel.assertIsDisplayed()
    }

    @Test
    fun keyboardFocusFallsOnTheFirstOptionWhenCurrentModelIsAbsentFromCatalog() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            val keyboard =
                object : InputModeManager {
                    override val inputMode = InputMode.Keyboard

                    override fun requestInputMode(inputMode: InputMode) =
                        inputMode == this.inputMode
                }
            render(ToolFixture("gpt-image-newer-client"), keyboard)
            compose.onNodeWithText("Image generation model").performClick()

            compose.onNode(hasText("GPT Image 1") and isSelectable()).assertIsFocused()
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    private fun render(
        service: BuiltInToolsService,
        inputModeManager: InputModeManager? = null,
        nowMillis: () -> Long = System::currentTimeMillis,
    ): BuiltInToolsSettings {
        val model =
            BuiltInToolsSettings(
                scope,
                service,
                WorkspaceIdentity("https://api.okou.ai", "user-a", "session-a", "org-a"),
                cache = null,
                authorized = { true },
                onSessionFailure = { throw it },
                nowMillis = nowMillis,
                notice = {},
            )
        compose.setContent {
            CompositionLocalProvider(
                LocalInputModeManager provides (inputModeManager ?: LocalInputModeManager.current),
            ) {
                OkouTheme(dark = false) {
                    val snackbar = remember { SnackbarHostState() }
                    Column {
                        BuiltInToolsPage("My Space", model)
                        PaneFeedback(
                            listOf(
                                settingsRefreshError(
                                    snackbar,
                                    model.state
                                        .collectAsStateWithLifecycle()
                                        .value
                                        .catalog
                                        .refreshFailure,
                                    R.string.settings_tools_unavailable,
                                    model::dismissCatalogFailure,
                                ),
                            ),
                        )
                        WorkspaceFeedbackHost(snackbar, Modifier)
                    }
                }
            }
        }
        return model
    }

    private class ToolFixture(private val currentImage: String = "gpt-image-2.5-flare") :
        BuiltInToolsService {
        var imageEnabled = true

        override suspend fun catalog(): List<DataToolFamily> = emptyList()

        override suspend fun disabledTools(): Set<String> =
            if (imageEnabled) emptySet() else setOf(imageGenerationTool)

        override suspend fun setEnabled(id: String, enabled: Boolean): Boolean {
            if (id == imageGenerationTool) imageEnabled = enabled
            return enabled
        }

        override suspend fun imageModel() = currentImage

        override suspend fun selectImageModel(id: String) = id
    }
}
