package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.OkouTheme
import ai.okou.android.PaneFeedback
import ai.okou.android.R
import ai.okou.android.SettingsRow
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.DefaultModelPreference
import ai.okou.android.api.generated.DefaultModelPreferenceServiceTier
import ai.okou.android.api.generated.UpdateDefaultModelPreference
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.state.SettingsDestination
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp")
class DefaultModelSettingTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun fastUsesCatalogMultiplierAndResetsWhenSelectingAnotherModelOrAuto() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        instrumentation.setInTouchMode(false)
        try {
            ChatListApiFixture().use { api ->
                val fixture =
                    DefaultModelApiFixture(
                            api,
                            gptModel = "gpt-6.2-sol",
                            gptLabel = "GPT 6.2 Sol",
                        )
                        .apply { gptFastMultiplier = null }
                val file = temporary.newFolder().resolve("default-model.preferences_pb")
                val store = DefaultModelStore(PreferenceDataStoreFactory.create { file }, scope)
                store.save(
                    api.identity,
                    DefaultModelRecord(
                        confirmed = DefaultModelPreference("gpt-6.2-sol", null, emptyMap()),
                    ),
                )
                val model =
                    DefaultModelSettings(scope, api.service, api.identity, store, { true }) {
                        throw it
                    }
                compose.runOnIdle {
                    model.foreground(true)
                    model.showSettings(SettingsDestination.Overview)
                }
                val snackbar = SnackbarHostState()
                compose.setContent {
                    OkouTheme(dark = false) {
                        DefaultModelSetting(model, snackbar, onFeedbackInOverlay = {})
                    }
                }
                compose.waitUntil("Saved model and catalog are loaded", 10_000) {
                    compose.runOnIdle {
                        model.state.value.options != null && model.state.value.record != null
                    }
                }
                compose.onNodeWithText("Default model").performClick()
                val gpt = compose.onNode(hasText("GPT 6.2 Sol") and isSelectable())
                val claude = compose.onNode(hasText("Claude Sonnet 5") and isSelectable())
                val auto = compose.onNode(hasText("Auto") and isSelectable())
                val fast = compose.onNodeWithText("Fast mode")
                gpt.assertIsSelected()
                fast.assertDoesNotExist()

                fun setMultiplier(value: Double) {
                    compose.runOnIdle {
                        model.foreground(false)
                        fixture.gptFastMultiplier = value
                        model.foreground(true)
                    }
                }

                fun awaitSave(count: Int) {
                    compose.waitUntil("Model preference is confirmed", 10_000) {
                        compose.runOnIdle {
                            fixture.writes.size == count && model.state.value.pending == null
                        }
                    }
                }

                setMultiplier(3.12567)
                compose.waitUntil("Fast multiplier from the updated catalog is available", 10_000) {
                    compose.runOnIdle { model.state.value.selected?.fastMultiplier == 3.12567 }
                }
                compose
                    .onNodeWithText(
                        "When on, uses 3.12567× as much of your ChatGPT subscription as standard mode",
                    )
                    .assertIsDisplayed()
                fast.assertIsOff().performClick().assertIsOn()
                awaitSave(1)
                assertEquals(JsonPrimitive("priority"), fixture.writes.last()["serviceTier"])

                val effort = compose.onNodeWithContentDescription("Reasoning effort")
                effort.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
                effort.assertIsFocused().performKeyInput { pressKey(Key.Enter) }
                val medium = compose.onNode(hasText("Medium") and isSelectable())
                medium.assertIsSelected().performKeyInput { pressKey(Key.Tab) }
                medium.assertDoesNotExist()
                effort.assertIsFocused().performKeyInput { pressKey(Key.Enter) }
                compose.onNode(hasText("High") and isSelectable()).performClick()
                effort.assertIsFocused()
                awaitSave(2)
                assertEquals(JsonPrimitive("priority"), fixture.writes.last()["serviceTier"])
                assertEquals(
                    JsonPrimitive("high"),
                    fixture.writes.last()["modelSettingsPatch"]?.jsonObject?.get("effort"),
                )

                claude.performClick().assertIsSelected()
                awaitSave(3)
                fast.assertDoesNotExist()
                assertEquals(JsonNull, fixture.writes.last()["serviceTier"])

                gpt.performClick().assertIsSelected()
                awaitSave(4)
                fast.assertIsOff()
                compose.onNodeWithText("High").assertIsDisplayed()
                auto.performClick().assertIsSelected()
                awaitSave(5)
                fast.assertDoesNotExist()
                assertEquals(JsonNull, fixture.writes.last()["selectedModel"])
                assertEquals(JsonNull, fixture.writes.last()["serviceTier"])

                gpt.performClick().assertIsSelected()
                awaitSave(6)
                fast.assertIsOff()
                fast.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
                setMultiplier(0.0)
                compose.waitUntil("Invalid Fast multiplier is ignored", 10_000) {
                    compose.runOnIdle { model.state.value.selected?.fastMultiplier == null }
                }
                fast.assertDoesNotExist()
                gpt.assertIsFocused()

                setMultiplier(2.0)
                compose.waitUntil("Fast returns with a valid multiplier", 10_000) {
                    compose.runOnIdle { model.state.value.selected?.fastMultiplier == 2.0 }
                }
                fast.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
                compose.runOnIdle {
                    model.foreground(false)
                    fixture.planRestricted = true
                    model.foreground(true)
                }
                compose.waitUntil("Selected model becomes unavailable", 10_000) {
                    compose.runOnIdle { model.state.value.selected?.canSelect == false }
                }
                fast.assertDoesNotExist()
                compose.onNodeWithContentDescription("Back").assertIsFocused()
                assertEquals(6, fixture.writes.size)
            }
        } finally {
            scope.cancel()
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun catalogChangesReturnFocusWhenTheReasoningFieldDisappears() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            val model =
                DefaultModelChoice(
                    "gpt",
                    "GPT 6.2 Sol",
                    canSelect = true,
                    efforts = listOf(ModelEffort.MEDIUM),
                    defaultEffort = ModelEffort.MEDIUM,
                    fastMultiplier = null,
                )
            val choices = mutableStateOf(listOf(model))
            compose.setContent {
                OkouTheme(dark = false) {
                    ModelPickerSheet(
                        title = "Default model",
                        choices = choices.value,
                        selectedId = model.id,
                        effort = ModelEffort.MEDIUM,
                        fast = false,
                        select = {},
                        selectEffort = {},
                        selectFast = {},
                        dismiss = {},
                    )
                }
            }
            val effort = compose.onNodeWithContentDescription("Reasoning effort")
            val gpt = compose.onNode(hasText(model.label) and isSelectable())
            effort.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            effort.assertIsFocused()

            compose.runOnIdle { choices.value = listOf(model.copy(efforts = emptyList())) }
            effort.assertDoesNotExist()
            gpt.assertIsFocused()

            compose.runOnIdle { choices.value = listOf(model) }
            effort.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            effort.assertIsFocused()
            compose.runOnIdle { choices.value = listOf(model.copy(canSelect = false)) }

            effort.assertDoesNotExist()
            compose.onNodeWithContentDescription("Back").assertIsFocused()
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun anUnavailableSavedModelCanBeResetToAutoWithoutClosingThePicker() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            ChatListApiFixture().use { api ->
                val fixture = DefaultModelApiFixture(api).apply { onlyAuto = true }
                val file = temporary.newFolder().resolve("default-model.preferences_pb")
                val store = DefaultModelStore(PreferenceDataStoreFactory.create { file }, scope)
                store.save(
                    api.identity,
                    DefaultModelRecord(
                        confirmed =
                            DefaultModelPreference(
                                "gpt-test",
                                DefaultModelPreferenceServiceTier.PRIORITY,
                                emptyMap(),
                            ),
                        confirmedLabel = "GPT 5.6 Sol",
                    ),
                )
                val model =
                    DefaultModelSettings(scope, api.service, api.identity, store, { true }) {
                        throw it
                    }
                compose.runOnIdle {
                    model.foreground(true)
                    model.showSettings(SettingsDestination.Overview)
                }
                val snackbar = SnackbarHostState()
                val accounts = FocusRequester()
                compose.setContent {
                    OkouTheme(dark = false) {
                        Column {
                            DefaultModelSetting(model, snackbar, {}, accounts)
                            SettingsRow(
                                "Model accounts",
                                leading = {},
                                modifier = Modifier.focusRequester(accounts),
                                onClick = {},
                            )
                        }
                    }
                }
                compose.waitUntil("Saved preference and catalog are loaded", 10_000) {
                    compose.runOnIdle {
                        model.state.value.options != null && model.state.value.record != null
                    }
                }
                val entry = compose.onNodeWithText("Default model")
                compose.onNodeWithText("GPT 5.6 Sol").assertIsDisplayed()
                entry.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
                entry.assertIsFocused().performKeyInput { pressKey(Key.Enter) }

                val auto = compose.onNode(hasText("Auto") and isSelectable())
                auto.assertIsNotSelected().assertIsFocused().performClick().assertIsSelected()
                compose.waitUntil("Auto preference is confirmed", 10_000) {
                    compose.runOnIdle {
                        fixture.writes.size == 1 && model.state.value.pending == null
                    }
                }
                assertEquals(JsonNull, fixture.writes.single()["selectedModel"])
                assertEquals(JsonNull, fixture.writes.single()["serviceTier"])
                auto.assertIsDisplayed().assertIsSelected()
                compose.onNodeWithContentDescription("Back").performClick()

                entry.assertDoesNotExist()
                compose.onNodeWithText("Model accounts").assertIsFocused()
            }
        } finally {
            scope.cancel()
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun pickerKeepsCachedChoicesEditableDuringCatalogRefresh() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        instrumentation.setInTouchMode(false)
        try {
            ChatListApiFixture().use { api ->
                val fixture = DefaultModelApiFixture(api)
                val file = temporary.newFolder().resolve("default-model.preferences_pb")
                val store = DefaultModelStore(PreferenceDataStoreFactory.create { file }, scope)
                val initialCatalog = CompletableDeferred<Unit>()
                val pendingSave = CompletableDeferred<Unit>()
                var catalogFails = false
                val service =
                    object : WorkspaceSession by api.service {
                        override suspend fun recoveryCatalog() =
                            initialCatalog.await().let {
                                if (catalogFails) throw ApiFailure.Http(400, null, null, null)
                                api.service.recoveryCatalog()
                            }

                        override suspend fun updateDefaultModelPreference(
                            update: UpdateDefaultModelPreference,
                        ) =
                            pendingSave.await().let {
                                api.service.updateDefaultModelPreference(update)
                            }
                    }
                val model =
                    DefaultModelSettings(scope, service, api.identity, store, { true }) {
                        if (!catalogFails || it !is ApiFailure.Http || it.status != 400) throw it
                    }
                compose.runOnIdle {
                    model.foreground(true)
                    model.showSettings(SettingsDestination.Overview)
                }
                val snackbar = SnackbarHostState()
                compose.setContent {
                    OkouTheme(dark = false) {
                        Column {
                            PaneFeedback(
                                listOf(
                                    settingsRefreshError(
                                        snackbar,
                                        model.state
                                            .collectAsStateWithLifecycle()
                                            .value
                                            .settingsCatalogRefreshFailure,
                                        R.string.settings_model_catalog_refresh_failed,
                                        model::dismissCatalogFailure,
                                    ),
                                ),
                            )
                            DefaultModelSetting(model, snackbar, onFeedbackInOverlay = {})
                        }
                    }
                }

                val row = compose.onNodeWithText("Default model")
                row.assertIsDisplayed().assertHasNoClickAction()
                compose.waitUntil(10_000) { model.state.value.record != null }
                compose.onNodeWithText("Auto").assertIsDisplayed()
                initialCatalog.complete(Unit)
                compose.waitUntil(10_000) {
                    compose.runOnIdle { model.state.value.options != null }
                }
                row.performClick()

                val gpt = compose.onNode(hasText("GPT 5.6 Sol") and isSelectable())
                val claude = compose.onNode(hasText("Claude Sonnet 5") and isSelectable())
                gpt.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
                assertTrue(
                    gpt.getUnclippedBoundsInRoot().top < claude.getUnclippedBoundsInRoot().top,
                )

                compose.runOnIdle {
                    model.foreground(false)
                    fixture.gptSortOrder = 3
                    model.foreground(true)
                }
                compose.waitUntil(10_000) {
                    compose.runOnIdle {
                        model.state.value.options?.choices?.lastOrNull()?.id == "gpt-test"
                    }
                }
                assertTrue(
                    claude.getUnclippedBoundsInRoot().top < gpt.getUnclippedBoundsInRoot().top,
                )
                gpt.assertIsFocused()

                val auto = compose.onNode(hasText("Auto") and isSelectable())
                val listTop = auto.getUnclippedBoundsInRoot().top
                compose.runOnIdle {
                    model.foreground(false)
                    catalogFails = true
                    model.foreground(true)
                }
                compose.waitUntil("Cached catalog failure reaches the model", 10_000) {
                    compose.runOnIdle { model.state.value.settingsCatalogRefreshFailure != null }
                }
                compose
                    .onNodeWithText(
                        "Could not refresh available models. Showing the last loaded list.",
                    )
                    .assertIsDisplayed()
                assertEquals(listTop, auto.getUnclippedBoundsInRoot().top)
                gpt.assertIsFocused()
                compose.runOnIdle { model.foreground(false) }
                compose
                    .onNodeWithText(
                        "Could not refresh available models. Showing the last loaded list.",
                    )
                    .assertDoesNotExist()
                assertEquals(listTop, auto.getUnclippedBoundsInRoot().top)
                claude.assertIsEnabled().performClick().assertIsSelected()
                assertTrue(fixture.writes.isEmpty())
                compose.runOnIdle { pendingSave.complete(Unit) }
                compose.waitUntil(10_000) {
                    compose.runOnIdle { model.state.value.pending == null }
                }
                assertEquals(1, fixture.writes.size)
            }
        } finally {
            scope.cancel()
            instrumentation.resetInTouchMode()
        }
    }
}
