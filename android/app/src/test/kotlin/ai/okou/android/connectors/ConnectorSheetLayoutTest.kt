package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_CALENDAR_PRIMARY
import ai.okou.android.CONNECTOR_CALENDAR_SECONDARY
import ai.okou.android.CONNECTOR_EXAMPLE_DEVICE_CODE
import ai.okou.android.CONNECTOR_EXAMPLE_EXTERNAL_CODE
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.util.concurrent.CountDownLatch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class ConnectorSheetLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun deviceSetupRequiresACurrentCatalogChoiceBeforeRequestingACode() {
        ConnectorApiFixture(includeGrantExamples = true, requireDeviceEnvironment = true).use {
            fixture ->
            withConnectors(fixture) { model ->
                compose
                    .onNodeWithTag("connector-search")
                    .performTextReplacement("Device authorization")
                val service = "Device authorization sample"
                compose.waitUntilAtLeastOneExists(hasText(service), 10_000)
                compose.onNodeWithText(service).performClick()
                compose.waitUntilAtLeastOneExists(hasText("Connect account"), 10_000)
                compose.onNodeWithText("Connect account").performClick()
                val submit = compose.onNodeWithText("Continue to provider")
                submit.assertIsNotEnabled()
                compose
                    .onNodeWithText("Live workspace")
                    .assertHeightIsAtLeast(56.dp)
                    .performClick()
                    .assertIsSelected()
                submit.assertIsEnabled()

                fixture.offerLiveDeviceEnvironment = false
                compose.runOnIdle { model.resume() }
                compose.waitUntilDoesNotExist(hasText("Live workspace"), 10_000)
                submit.assertIsNotEnabled()
                compose.onNodeWithText("Test workspace").performClick().assertIsSelected()
                submit.assertIsEnabled().performClick()
                compose.waitUntilAtLeastOneExists(hasText(CONNECTOR_EXAMPLE_DEVICE_CODE), 10_000)
                assertEquals(1, fixture.deviceStartRequests.get())
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun externalCodeKeepsTheFieldAndActionsThroughValidationAndReceiptReadback() {
        ConnectorApiFixture(includeGrantExamples = true).use { fixture ->
            withConnectors(fixture) {
                openExternalCodeForm()

                val field = compose.onNodeWithTag("connector-input")
                val cancel = compose.onNodeWithText("Cancel")
                val confirm = compose.onNodeWithText("Confirm code")
                val cancelBounds = cancel.getUnclippedBoundsInRoot()
                confirm.assertIsNotEnabled()

                field.performTextReplacement(" " + "x".repeat(CONNECTOR_EXTERNAL_CODE_LIMIT) + " ")
                confirm.assertIsEnabled()
                val limitBounds = field.getUnclippedBoundsInRoot()
                field.performTextReplacement("x".repeat(CONNECTOR_EXTERNAL_CODE_LIMIT + 1) + " ")
                val tooLong = "Maximum code length is ${CONNECTOR_EXTERNAL_CODE_LIMIT}."
                field.assert(SemanticsMatcher.expectValue(SemanticsProperties.Error, tooLong))
                confirm.assertIsNotEnabled()
                assertEquals(limitBounds, field.getUnclippedBoundsInRoot())

                field.performTextReplacement("invalid-fixture-code")
                val rejectionBounds = field.getUnclippedBoundsInRoot()
                confirm.assertIsEnabled().performClick()
                val failure = "Code verification failed."
                compose.waitUntilAtLeastOneExists(hasText(failure), 10_000)
                field.assert(SemanticsMatcher.expectValue(SemanticsProperties.Error, failure))
                assertEquals(rejectionBounds, field.getUnclippedBoundsInRoot())
                assertEquals(cancelBounds, cancel.getUnclippedBoundsInRoot())

                fixture.loseFirstExternalCodeReply = true
                fixture.externalCodeReplyGate = CountDownLatch(1)
                fixture.externalAccountReplyGate = CountDownLatch(1)
                field.performTextReplacement("  $CONNECTOR_EXAMPLE_EXTERNAL_CODE  ")
                val fieldBounds = field.getUnclippedBoundsInRoot()
                confirm.assertIsEnabled().performClick()
                compose.waitUntil(10_000) { fixture.externalCodeRequests.get() == 2 }
                val checking = compose.onNodeWithText("Checking…")
                checking.assertIsNotEnabled()
                assertEquals(fieldBounds, field.getUnclippedBoundsInRoot())
                assertEquals(cancelBounds, cancel.getUnclippedBoundsInRoot())

                fixture.externalCodeReplyGate?.countDown()
                val check = "Check authorization"
                compose.waitUntilAtLeastOneExists(hasText(check), 10_000)
                compose.onNodeWithText("The outcome is still unconfirmed.").assertIsDisplayed()
                compose.onNodeWithText(check).assertIsEnabled().performClick()
                compose.waitUntil(10_000) {
                    compose.runOnIdle { fixture.externalAccountReadStarted.count == 0L }
                }
                checking.assertIsNotEnabled()
                assertEquals(fieldBounds, field.getUnclippedBoundsInRoot())
                assertEquals(cancelBounds, cancel.getUnclippedBoundsInRoot())

                fixture.externalAccountReplyGate?.countDown()
                compose.waitUntilDoesNotExist(hasTestTag("connector-sheet"), 10_000)
                compose.onNodeWithText("Verified account").assertIsDisplayed()
                assertEquals(3, fixture.externalCodeRequests.get())
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun externalCodeChecksTheOriginalAttemptAfterTheFormIsRecreated() {
        val restoration = StateRestorationTester(compose)
        ConnectorApiFixture(includeGrantExamples = true).use { fixture ->
            withConnectors(fixture, restoration) {
                openExternalCodeForm()
                fixture.loseFirstExternalCodeReply = true
                fixture.externalCodeStillCompleting = true
                fixture.externalAccountReplyGate = CountDownLatch(1)
                compose
                    .onNodeWithTag("connector-input")
                    .performTextReplacement(CONNECTOR_EXAMPLE_EXTERNAL_CODE)
                compose.onNodeWithText("Confirm code").performClick()
                val pending = "The outcome is still unconfirmed."
                compose.waitUntilAtLeastOneExists(hasText(pending), 10_000)
                restoration.emulateSavedInstanceStateRestore()
                compose.waitUntilAtLeastOneExists(hasText(pending), 10_000)
                val check = compose.onNodeWithText("Check authorization")
                check.assertIsEnabled().performClick()
                compose.waitUntil(10_000) {
                    compose.runOnIdle { fixture.externalCodeRequests.get() == 2 }
                }
                compose.waitUntilAtLeastOneExists(hasText(pending), 10_000)
                fixture.externalCodeStillCompleting = false
                check.assertIsEnabled().performClick()
                compose.waitUntil(10_000) {
                    compose.runOnIdle { fixture.externalAccountReadStarted.count == 0L }
                }
                restoration.emulateSavedInstanceStateRestore()
                compose.waitUntilAtLeastOneExists(hasText("Checking…"), 10_000)
                compose.onNodeWithTag("connector-input").assertIsDisplayed()
                compose.onNodeWithText("Checking…").assertIsNotEnabled()
                fixture.externalAccountReplyGate?.countDown()
                compose.waitUntilDoesNotExist(hasTestTag("connector-sheet"), 10_000)
                compose.onNodeWithText("Verified account").assertIsDisplayed()
                assertEquals(3, fixture.externalCodeRequests.get())
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun dismissedExternalReceiptKeepsCheckingWithoutReopeningTheForm() {
        val restoration = StateRestorationTester(compose)
        ConnectorApiFixture(includeGrantExamples = true).use { fixture ->
            withConnectors(fixture, restoration) {
                openExternalCodeForm()
                fixture.failAccountReads = true
                compose
                    .onNodeWithTag("connector-input")
                    .performTextReplacement(CONNECTOR_EXAMPLE_EXTERNAL_CODE)
                compose.onNodeWithText("Confirm code").performClick()
                val check = "Check authorization"
                compose.waitUntilAtLeastOneExists(hasText(check), 10_000)
                compose.onNodeWithText("Cancel").assertIsEnabled().performClick()
                compose.waitUntilDoesNotExist(hasTestTag("connector-sheet"), 10_000)
                restoration.emulateSavedInstanceStateRestore()
                compose.onNodeWithTag("connector-detail").assertIsDisplayed()
                compose.onNodeWithTag("connector-sheet").assertDoesNotExist()
                fixture.failAccountReads = false
                compose.waitUntilAtLeastOneExists(hasText("Verified account"), 10_000)
                compose.onNodeWithTag("connector-sheet").assertDoesNotExist()
                assertEquals(1, fixture.externalCodeRequests.get())
            }
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w760dp-h892dp")
    fun bottomSheetUsesAvailableSpaceAndKeepsActionsBelowTheScrollBody() {
        showLongSheet()
        val panel = compose.onNodeWithTag("connector-sheet")
        val actions = compose.onNodeWithTag("sheet-actions")
        panel.assertWidthIsEqualTo(640.dp).assertHeightIsAtLeast(760.dp)
        val footer = actions.assertIsDisplayed().getUnclippedBoundsInRoot()
        assertEquals(22.dp, panel.getUnclippedBoundsInRoot().bottom - footer.bottom)
        compose.onNodeWithText("Permission 22").performScrollTo().assertIsDisplayed()
        assertEquals(footer, actions.getUnclippedBoundsInRoot())
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun firstAccountReadFailureStaysInTheSectionUntilRecovery() {
        ConnectorApiFixture().use { fixture ->
            fixture.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
            fixture.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
            fixture.accountRetryAfterSeconds = 0
            fixture.failAccountReads = true
            withConnectors(fixture) { model ->
                compose.waitUntilAtLeastOneExists(hasText("Google Calendar"), 10_000)
                compose.onNodeWithText("Google Calendar").performClick()
                val failure = "Temporarily unable to load"
                compose.waitUntilAtLeastOneExists(hasText(failure), 10_000)
                compose.onNodeWithText("Google Calendar").assertIsDisplayed()
                compose.onNodeWithText("Accounts").assertIsDisplayed()
                val permissions = compose.onNodeWithText("Permissions this service can request")
                permissions.assertIsEnabled()
                compose.onNodeWithText("Could not load accounts.").assertDoesNotExist()
                compose.onNodeWithText("Connect account").assertDoesNotExist()

                fixture.failAccountReads = false
                compose.runOnIdle {
                    model.pause()
                    model.resume()
                }
                compose.waitUntilAtLeastOneExists(hasText("Connect account"), 10_000)
                compose.onNodeWithText("Connect account").assertIsEnabled()
                compose.onNodeWithText(failure).assertDoesNotExist()
                permissions.assertIsEnabled()
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun permissionFirstReadFailureUsesThePanelIllustrationSize() {
        ConnectorApiFixture().use { fixture ->
            fixture.failPermissionReads = true
            withConnectors(fixture) {
                compose.waitUntilAtLeastOneExists(hasText("Google Calendar"), 10_000)
                compose.onNodeWithText("Google Calendar").performClick()
                val permissions = "Permissions this service can request"
                compose.waitUntilAtLeastOneExists(hasText(permissions), 10_000)
                compose.onNodeWithText(permissions).performClick()
                val failure = "Temporarily unable to load"
                compose.waitUntilAtLeastOneExists(hasText(failure), 10_000)
                val label = compose.onNodeWithText(failure).assertIsDisplayed()
                val illustration =
                    compose
                        .onNodeWithTag("content-read-failure-illustration", useUnmergedTree = true)
                        .assertWidthIsEqualTo(112.dp)
                assertEquals(
                    12.dp,
                    label.getUnclippedBoundsInRoot().top -
                        illustration.getUnclippedBoundsInRoot().bottom,
                )
                compose.onNodeWithText("Close").assertIsEnabled().performClick()
                compose.onNodeWithText(permissions).assertIsDisplayed()
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun permissionRefreshFeedbackStaysAboveTheCloseAction() {
        ConnectorApiFixture().use { fixture ->
            withConnectors(fixture) { model ->
                compose.waitUntilAtLeastOneExists(hasText("Google Calendar"), 10_000)
                compose.onNodeWithText("Google Calendar").performClick()
                val permissions = "Permissions this service can request"
                compose.waitUntilAtLeastOneExists(hasText(permissions), 10_000)
                compose.onNodeWithText(permissions).performClick()
                val ready = "读取日历与日程"
                compose.waitUntilAtLeastOneExists(hasText(ready), 10_000)
                val close = compose.onNodeWithText("Close").assertIsDisplayed()
                val closeBounds = close.getUnclippedBoundsInRoot()
                val permission = compose.onNodeWithText(ready)
                val permissionBounds = permission.getUnclippedBoundsInRoot()

                fixture.failPermissionReads = true
                compose.runOnIdle {
                    model.pause()
                    model.resume()
                }
                val feedback = "Could not refresh connectors."
                compose.waitUntilAtLeastOneExists(hasText(feedback), 10_000)
                val feedbackBounds = compose.onNodeWithText(feedback).getUnclippedBoundsInRoot()
                assertTrue(feedbackBounds.bottom < closeBounds.top)
                assertEquals(closeBounds, close.getUnclippedBoundsInRoot())
                assertEquals(permissionBounds, permission.getUnclippedBoundsInRoot())
                close.assertIsEnabled().performClick()
                compose.onNodeWithText(permissions).assertIsDisplayed()
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun accountRefreshFeedbackKeepsTheRenameDraftAndDoesNotReplayOnReturn() {
        ConnectorApiFixture().use { fixture ->
            withConnectors(fixture) { model ->
                val calendar = "Google Calendar"
                compose.waitUntilAtLeastOneExists(hasText(calendar), 10_000)
                compose.onNodeWithText(calendar).performClick()
                val account = "connector-account-$CONNECTOR_CALENDAR_PRIMARY"
                compose.waitUntilAtLeastOneExists(hasTestTag(account), 10_000)
                compose.onNodeWithTag(account).performClick()
                val rename = hasText("Rename") and isEnabled()
                compose.waitUntilAtLeastOneExists(rename, 10_000)
                compose.onNode(rename).performClick()
                val input = compose.onNodeWithTag("connector-input")
                val save = compose.onNodeWithText("Save")
                val cancel = compose.onNodeWithText("Cancel")
                val draft = "New calendar name"
                input.performTextReplacement(draft)
                val inputBounds = input.getUnclippedBoundsInRoot()
                val saveBounds = save.assertIsEnabled().getUnclippedBoundsInRoot()

                fixture.accountRetryAfterSeconds = 0
                fixture.failAccountReads = true
                compose.runOnIdle { model.resume() }
                val feedback = hasText("Could not refresh connectors.")
                val inSheet = hasAnyAncestor(hasTestTag("connector-sheet"))
                compose.waitUntilAtLeastOneExists(feedback and inSheet, 10_000)
                compose.onNode(feedback and !inSheet).assertDoesNotExist()
                assertEquals(inputBounds, input.getUnclippedBoundsInRoot())
                assertEquals(saveBounds, save.assertIsEnabled().getUnclippedBoundsInRoot())
                input.assertTextContains(draft)

                cancel.performClick()
                compose.onNode(rename).assertIsDisplayed()
                compose.onNode(feedback).assertDoesNotExist()
            }
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w820dp-h440dp")
    fun shortAuthorizationUsesFullWidthAndACompactFooter() {
        showLongSheet()
        val panel = compose.onNodeWithTag("connector-sheet")
        val actions = compose.onNodeWithTag("sheet-actions")
        panel.assertWidthIsEqualTo(820.dp)
        val footer = actions.assertIsDisplayed().getUnclippedBoundsInRoot()
        assertEquals(12.dp, panel.getUnclippedBoundsInRoot().bottom - footer.bottom)
        compose.onNodeWithText("Permission 22").performScrollTo().assertIsDisplayed()
        assertEquals(footer, actions.getUnclippedBoundsInRoot())
    }

    @OptIn(ExperimentalTestApi::class)
    private fun openExternalCodeForm() {
        val service = "External code sample"
        compose.onNodeWithTag("connector-search").performTextReplacement("External code")
        compose.waitUntilAtLeastOneExists(hasText(service), 10_000)
        compose.onNodeWithText(service).performClick()
        compose.waitUntilAtLeastOneExists(hasText("Connect account"), 10_000)
        compose.onNodeWithText("Connect account").performClick()
        compose.onNodeWithText("Continue to provider").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("connector-input"), 10_000)
    }

    private fun withConnectors(
        fixture: ConnectorApiFixture,
        restoration: StateRestorationTester? = null,
        exercise: (ConnectorModel) -> Unit,
    ) {
        val store = ViewModelStore()
        try {
            val model = compose.runOnIdle {
                ViewModelProvider.create(
                        store,
                        viewModelFactory {
                            initializer {
                                ConnectorModel(fixture.service, { true }) {
                                    throw AssertionError(it)
                                }
                            }
                        },
                    )[ConnectorModel::class]
            }
            val content: @Composable () -> Unit = {
                OkouTheme(false) { ConnectorsPage(model, null) {} }
            }
            if (restoration == null) compose.setContent(content)
            else restoration.setContent(content)
            exercise(model)
        } finally {
            compose.runOnIdle { store.clear() }
        }
    }

    private fun showLongSheet() {
        compose.setContent {
            OkouTheme(false) {
                ConnectorSheet(
                    title = "Connector",
                    dismiss = {},
                    expandInShortWindow = true,
                    actions = {
                        Box(Modifier.fillMaxWidth().testTag("sheet-actions")) {
                            ConnectorCloseAction({})
                        }
                    },
                ) {
                    repeat(22) { index -> Text("Permission ${index + 1}", Modifier.height(48.dp)) }
                }
            }
        }
    }
}
