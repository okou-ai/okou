package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.OkouTheme
import ai.okou.android.SettingsRow
import ai.okou.android.api.generated.DefaultModelPreference
import ai.okou.android.api.generated.DefaultModelPreferenceServiceTier
import ai.okou.android.api.generated.UpdateDefaultModelPreference
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.state.SettingsDestination
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.SnackbarHostState
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
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonNull
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
                compose.waitUntil(10_000) {
                    model.state.value.options != null && model.state.value.record != null
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
                val service =
                    object : WorkspaceSession by api.service {
                        override suspend fun recoveryCatalog() =
                            initialCatalog.await().let { api.service.recoveryCatalog() }

                        override suspend fun updateDefaultModelPreference(
                            update: UpdateDefaultModelPreference,
                        ) =
                            pendingSave.await().let {
                                api.service.updateDefaultModelPreference(update)
                            }
                    }
                val model =
                    DefaultModelSettings(scope, service, api.identity, store, { true }) {
                        throw it
                    }
                compose.runOnIdle {
                    model.foreground(true)
                    model.showSettings(SettingsDestination.Overview)
                }
                val snackbar = SnackbarHostState()
                compose.setContent {
                    OkouTheme(dark = false) {
                        Column { DefaultModelSetting(model, snackbar, onFeedbackInOverlay = {}) }
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
                compose.runOnIdle { model.foreground(false) }
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
