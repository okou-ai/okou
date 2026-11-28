package ai.okou.android.settings

import ai.okou.android.FeedbackReceipt
import ai.okou.android.OkouTheme
import ai.okou.android.PaneFeedback
import ai.okou.android.PaneFeedbackError
import ai.okou.android.PaneFeedbackMessage
import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.WorkspaceFeedbackTimeout
import ai.okou.android.api.ApiFailure
import ai.okou.android.auth.WorkspaceIdentity
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToKey
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
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
    fun refreshingAnEmptyCatalogKeepsTheFollowingSectionInPlaceThroughFinalFailure() {
        val fixture = ToolFixture()
        val finishRefresh = CompletableDeferred<Unit>()
        var now = 0L
        val service =
            object : BuiltInToolsService by fixture {
                override suspend fun catalog(): List<DataToolFamily> {
                    if (now == 0L) return emptyList()
                    finishRefresh.await()
                    throw ApiFailure.Http(400, null, null, null)
                }
            }
        val model = render(service, nowMillis = { now })
        val imageSection = compose.onNodeWithText("Image generation model").assertIsEnabled()
        val position = imageSection.getUnclippedBoundsInRoot()
        val progress =
            compose.onNodeWithContentDescription(
                compose.activity.getString(R.string.settings_data_tools),
            )
        try {
            compose.runOnIdle {
                now = 600_001L
                model.refresh()
            }
            progress.assertIsDisplayed()
            assertEquals(position, imageSection.getUnclippedBoundsInRoot())
        } finally {
            finishRefresh.complete(Unit)
        }
        compose.onNodeWithText("Tools are temporarily unavailable.").assertIsDisplayed()
        progress.assertDoesNotExist()
        assertEquals(position, imageSection.getUnclippedBoundsInRoot())
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

    @Test
    fun imageSaveKeepsTheRowInPlaceAndReopensOnTheConfirmedModelAfterFailure() {
        val reject = CompletableDeferred<Unit>()
        val service =
            object : BuiltInToolsService by ToolFixture() {
                override suspend fun selectImageModel(id: String): String {
                    reject.await()
                    throw ApiFailure.Http(400, null, null, null)
                }
            }
        val model = render(service, onSessionFailure = { check(it is ApiFailure.Http) })
        val row = compose.onNodeWithText("Image generation model")
        val before = row.getUnclippedBoundsInRoot()
        val pending = compose.onNodeWithContentDescription("Saving…")
        val confirmed = "GPT Image 2.5 Flare"
        val attempted = "GPT Image 2.5 Sunburst"

        row.performClick()
        compose.onNode(hasText(attempted) and isSelectable()).performClick()
        pending.assertIsDisplayed()
        compose.onNodeWithText(attempted).assertIsDisplayed()
        assertEquals(before, row.assertIsEnabled().getUnclippedBoundsInRoot())

        compose.runOnIdle { reject.complete(Unit) }
        compose.waitUntil { model.state.value.pendingImage == null }
        pending.assertDoesNotExist()
        compose.onNodeWithText(confirmed).assertIsDisplayed()
        assertEquals(before, row.getUnclippedBoundsInRoot())
        row.performClick()
        compose.onNode(hasText(confirmed) and isSelectable()).assertIsSelected()
    }

    @Test
    fun imageSaveFailureIsVisibleInTheReopenedPicker() {
        val reject = CompletableDeferred<Unit>()
        val service =
            object : BuiltInToolsService by ToolFixture() {
                override suspend fun selectImageModel(id: String): String {
                    reject.await()
                    throw ApiFailure.Http(400, null, null, null)
                }
            }
        render(service, onSessionFailure = { check(it is ApiFailure.Http) })
        val picker = compose.onNodeWithText("Image generation model")
        val attempted = hasText("GPT Image 2.5 Sunburst") and isSelectable()
        val confirmed = hasText("GPT Image 2.5 Flare") and isSelectable()
        val failure = hasText(compose.activity.getString(R.string.settings_tool_image_save_failed))
        val dialogFailure = failure and hasAnyAncestor(isDialog())

        picker.assertIsEnabled().performClick()
        compose.onNode(attempted).performClick()
        picker.assertIsEnabled().performClick()
        compose.onNode(attempted).assertIsSelected()

        compose.runOnIdle { reject.complete(Unit) }
        compose.waitUntilExactlyOneExists(dialogFailure)
        compose.onNode(dialogFailure).assertIsDisplayed()
        compose.onAllNodes(failure).assertCountEquals(1)
        compose.onNode(confirmed).assertIsSelected()
    }

    @Test
    fun confirmedLegacyModelStaysInThePickerUntilItsReplacementIsSaved() {
        val legacyId = "fal-ai/bytedance/seedream/v4/text-to-image"
        val acknowledge = CompletableDeferred<Unit>()
        val service =
            object : BuiltInToolsService by ToolFixture(legacyId) {
                override suspend fun selectImageModel(id: String): String {
                    acknowledge.await()
                    return id
                }
            }
        render(service)
        val picker = compose.onNodeWithText("Image generation model")
        val choices = compose.onNode(hasScrollToIndexAction() and hasAnyAncestor(isDialog()))
        val legacy = hasText("Seedream 4") and isSelectable()
        val flare = hasText("GPT Image 2.5 Flare") and isSelectable()

        picker.performClick()
        compose.onNode(legacy).assertIsSelected()
        choices.performScrollToKey("gpt-image-2.5-flare")
        compose.onNode(flare).performClick()

        picker.performClick()
        compose.onNode(flare).assertIsSelected()
        choices.performScrollToKey(legacyId)
        compose.onNode(legacy).assertIsDisplayed()

        compose.runOnIdle { acknowledge.complete(Unit) }
        compose.waitUntilDoesNotExist(legacy)
        choices.performScrollToKey("gpt-image-2.5-flare")
        compose.onNode(flare).assertIsSelected()
    }

    private fun render(
        service: BuiltInToolsService,
        inputModeManager: InputModeManager? = null,
        nowMillis: () -> Long = System::currentTimeMillis,
        onSessionFailure: (Exception) -> Unit = { throw it },
    ): BuiltInToolsSettings {
        val imageFailure = mutableStateOf<FeedbackReceipt<SettingsNotice>?>(null)
        val model =
            BuiltInToolsSettings(
                scope,
                service,
                WorkspaceIdentity("https://api.okou.ai", "user-a", "session-a", "org-a"),
                cache = null,
                authorized = { true },
                onSessionFailure = onSessionFailure,
                nowMillis = nowMillis,
                notice = {
                    if (it == SettingsNotice.ImageModelSaveFailed) {
                        imageFailure.value = FeedbackReceipt(it)
                    }
                },
            )
        compose.setContent {
            CompositionLocalProvider(
                LocalInputModeManager provides (inputModeManager ?: LocalInputModeManager.current),
            ) {
                OkouTheme(dark = false) {
                    val snackbar = remember { SnackbarHostState() }
                    val feedbackInOverlay = remember { mutableStateOf(false) }
                    Column {
                        BuiltInToolsPage("My Space", model, snackbar) {
                            feedbackInOverlay.value = it
                        }
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
                                imageFailure.value?.let { receipt ->
                                    PaneFeedbackError(receipt.order) {
                                        PaneFeedbackMessage(
                                            snackbar,
                                            receipt,
                                            stringResource(
                                                R.string.settings_tool_image_save_failed,
                                            ),
                                        ) {
                                            imageFailure.value = null
                                        }
                                    }
                                },
                            ),
                        )
                        WorkspaceFeedbackTimeout(snackbar)
                        if (!feedbackInOverlay.value) {
                            WorkspaceFeedbackHost(snackbar, Modifier, manageTimeout = false)
                        }
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
