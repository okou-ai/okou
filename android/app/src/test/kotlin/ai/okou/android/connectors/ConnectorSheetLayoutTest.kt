package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.CONNECTOR_CALENDAR_PRIMARY
import ai.okou.android.CONNECTOR_CALENDAR_SECONDARY
import ai.okou.android.CONNECTOR_EXAMPLE_DEVICE_CODE
import ai.okou.android.CONNECTOR_EXAMPLE_EXTERNAL_CODE
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MemorySnapshotClock
import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import android.os.Looper
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
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TestTimeSource
import kotlin.time.TimeSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class ConnectorSheetLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun searchSkeletonWaitsForDispatchAndDisappearsWhenTheReadIsRetired() {
        ConnectorApiFixture().use { fixture ->
            withConnectors(fixture, snapshotClock = TestTimeSource()) { model ->
                val row = hasTestTag("connector-$CONNECTOR_CALENDAR")
                compose.waitUntilAtLeastOneExists(row, 10_000)
                val search = compose.onNodeWithTag("connector-search")
                val filter = compose.onNode(hasContentDescription("Filter by service category"))
                val discover = compose.onNodeWithText("Discover")
                val connected = compose.onNodeWithText("Connected")
                val skeletons = compose.onAllNodesWithTag("connector-directory-skeleton-row")
                val searchBounds = search.getUnclippedBoundsInRoot()
                val filterBounds = filter.getUnclippedBoundsInRoot()
                filter.assertWidthIsEqualTo(48.dp).assertHeightIsEqualTo(48.dp)
                discover.assertHeightIsAtLeast(48.dp)
                connected.assertHeightIsAtLeast(48.dp)
                val discoverBounds = discover.getUnclippedBoundsInRoot()
                val connectedBounds = connected.getUnclippedBoundsInRoot()
                assertEquals(
                    discoverBounds.right - discoverBounds.left,
                    connectedBounds.right - connectedBounds.left,
                )
                assertEquals(8.dp, searchBounds.top - discoverBounds.bottom)
                assertEquals(8.dp, filterBounds.left - searchBounds.right)
                val fastReply = CountDownLatch(1)
                val slowReply = CountDownLatch(1)
                val mainLooper = shadowOf(Looper.getMainLooper())
                compose.runOnIdle {
                    model.pause()
                    fixture.discoveryGate = fastReply
                }
                compose.mainClock.autoAdvance = false
                try {
                    search.performTextReplacement("calendar")
                    compose.mainClock.advanceTimeBy(320)
                    assertEquals("calendar", model.uiState.value.matches?.filter?.keyword)
                    skeletons.assertCountEquals(0)

                    compose.runOnUiThread { model.resume() }
                    mainLooper.idleFor(250, TimeUnit.MILLISECONDS)
                    checkNotNull(model.uiState.value.matches?.entries?.startedAt)
                    compose.mainClock.advanceTimeBy(112)
                    skeletons.assertCountEquals(0)
                    fastReply.countDown()
                    compose.waitUntil(10_000) {
                        mainLooper.idle()
                        model.uiState.value.matches?.entries?.data != null
                    }
                    compose.mainClock.advanceTimeBy(64)
                    compose.onNode(row).assertIsDisplayed()
                    skeletons.assertCountEquals(0)

                    fixture.discoveryGate = slowReply
                    search.performTextReplacement("no matching service")
                    compose.mainClock.advanceTimeBy(48)
                    mainLooper.idleFor(250, TimeUnit.MILLISECONDS)
                    val pending = checkNotNull(model.uiState.value.matches)
                    assertEquals("no matching service", pending.filter.keyword)
                    checkNotNull(pending.entries.startedAt)
                    compose.mainClock.advanceTimeBy(224)
                    skeletons.assertCountEquals(0)
                    compose.mainClock.advanceTimeBy(64)
                    skeletons.assertCountEquals(3)
                    assertEquals(searchBounds, search.getUnclippedBoundsInRoot())
                    assertEquals(filterBounds, filter.getUnclippedBoundsInRoot())

                    compose.runOnUiThread { model.pause() }
                    compose.mainClock.advanceTimeBy(48)
                    skeletons.assertCountEquals(0)
                } finally {
                    fastReply.countDown()
                    slowReply.countDown()
                    compose.mainClock.autoAdvance = true
                }
            }
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun coldConnectedCategoryWaitsForBothReadsAndKeepsItsSkeleton() {
        ConnectorApiFixture().use { fixture ->
            val overview = CountDownLatch(1)
            val category = CountDownLatch(1)
            fixture.overviewReplyGate = overview
            val clock = TestTimeSource()
            withConnectors(fixture, snapshotClock = clock) { model ->
                val row = hasTestTag("connector-$CONNECTOR_CALENDAR")
                compose.waitUntilAtLeastOneExists(row, 10_000)
                clock += 1.seconds
                compose.onNodeWithText("Connected").performClick()
                val filter = compose.onNode(hasContentDescription("Filter by service category"))
                filter.performClick()
                val meetings = compose.onNodeWithText("Meetings and scheduling").assertIsDisplayed()
                fixture.discoveryGate = category
                val skeletons = compose.onAllNodesWithTag("connector-directory-skeleton-row")
                val mainLooper = shadowOf(Looper.getMainLooper())
                compose.mainClock.autoAdvance = false
                try {
                    meetings.performClick()
                    compose.mainClock.advanceTimeBy(64)
                    checkNotNull(model.uiState.value.matches?.entries?.startedAt)
                    skeletons.assertCountEquals(0)
                    compose.mainClock.advanceTimeBy(288)
                    skeletons.assertCountEquals(3)

                    category.countDown()
                    compose.waitUntil(10_000) {
                        mainLooper.idle()
                        model.uiState.value.matches?.entries?.data != null
                    }
                    compose.mainClock.advanceTimeBy(64)
                    skeletons.assertCountEquals(3)

                    overview.countDown()
                    compose.waitUntil(10_000) {
                        mainLooper.idle()
                        model.uiState.value.connected.data != null
                    }
                    compose.mainClock.advanceTimeBy(64)
                    compose.onNode(row).assertIsDisplayed()
                    skeletons.assertCountEquals(0)
                } finally {
                    overview.countDown()
                    category.countDown()
                    compose.mainClock.autoAdvance = true
                }
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun directorySkeletonAndConnectedRowsUseNativeListGeometry() {
        ConnectorApiFixture().use { fixture ->
            fixture.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
            val discovery = CountDownLatch(1)
            fixture.discoveryGate = discovery
            withConnectors(fixture) {
                val skeletonTag = "connector-directory-skeleton-row"
                try {
                    compose.waitUntilAtLeastOneExists(hasTestTag(skeletonTag), 10_000)
                    val skeleton = compose.onAllNodesWithTag(skeletonTag)[0]
                    skeleton.assertHeightIsEqualTo(72.dp)
                    assertEquals(16.dp, skeleton.getUnclippedBoundsInRoot().left)
                } finally {
                    discovery.countDown()
                }

                val recommendations = compose.onNodeWithText("Recommended")
                val rowTag = "connector-${CONNECTOR_CALENDAR}"
                val discoverRow = compose.onNodeWithTag(rowTag)
                val confirmedRow = hasTestTag(rowTag) and hasText("1 account connected")
                compose.waitUntilAtLeastOneExists(confirmedRow, 10_000)
                assertEquals(32.dp, recommendations.getUnclippedBoundsInRoot().left)
                discoverRow.assertHeightIsAtLeast(88.dp)
                compose.onNodeWithText("Connected").performClick().assertIsSelected()
                val categories = compose.onNode(hasContentDescription("Filter by service category"))
                categories.performClick()
                compose.onNodeWithText("Meetings and scheduling").performClick()
                categories.assert(
                    SemanticsMatcher.expectValue(
                        SemanticsProperties.StateDescription,
                        "Meetings and scheduling",
                    ),
                )
                compose
                    .onNodeWithTag("connector-search")
                    .performTextReplacement("calendar@example.com")
                compose.waitUntilAtLeastOneExists(confirmedRow, 10_000)
                val connectedRow = compose.onNodeWithTag(rowTag)
                compose
                    .onNodeWithText("查看日程、查找空闲时间和创建会议。", useUnmergedTree = true)
                    .assertDoesNotExist()
                connectedRow.assertHeightIsAtLeast(72.dp)
                connectedRow.performClick()
                compose.waitUntilAtLeastOneExists(hasText("Add account"), 10_000)
                val touchBounds =
                    compose.onNodeWithText("Add account").fetchSemanticsNode().touchBoundsInRoot
                assertTrue(touchBounds.height >= with(compose.density) { 48.dp.toPx() })
                compose
                    .onNodeWithText("Permissions this service can request")
                    .assertHeightIsAtLeast(56.dp)
            }
        }
    }

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
    fun permissionRefreshFeedbackStaysOutsideTheSheet() {
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
                val feedback = hasText("Could not refresh connectors.")
                compose.waitUntilAtLeastOneExists(feedback and hasAnyAncestor(isPopup()), 10_000)
                val popup =
                    compose.onNode(isPopup() and hasAnyDescendant(feedback)).fetchSemanticsNode()
                val permissionTop = permission.fetchSemanticsNode().positionOnScreen.y
                assertTrue(popup.positionOnScreen.y + popup.size.height <= permissionTop)
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
    fun restoringTheRenameKeepsInvalidInputAndReturnsToTheSameAccount() {
        ConnectorApiFixture().use { fixture ->
            val restoration = StateRestorationTester(compose)
            withConnectors(fixture, restoration) {
                openCalendarRename()
                val input = compose.onNodeWithTag("connector-input")
                val selection = TextRange(1, 2)
                input.performClick().performTextReplacement("   ")
                input.performTextInputSelection(selection)

                restoration.emulateSavedInstanceStateRestore()

                input
                    .assertIsFocused()
                    .assert(
                        SemanticsMatcher.expectValue(
                            SemanticsProperties.TextSelectionRange,
                            selection,
                        ),
                    )
                compose.onNodeWithText("Enter an account name.").assertIsDisplayed()
                compose.onNodeWithText("Save").assertIsNotEnabled()
                compose.onNodeWithText("Cancel").performClick()
                val rename = hasText("Rename") and isEnabled()
                val panel = hasAnyAncestor(hasTestTag("connector-sheet"))
                compose.onNode(hasText("工作日历") and panel).assertIsDisplayed()
                compose.waitUntilAtLeastOneExists(rename, 10_000)
                compose.onNode(rename).performClick()
                input.assertTextContains("工作日历").performTextReplacement("  Team calendar  ")
                compose.onNodeWithText("Save").assertIsEnabled().performClick()
                val confirmedName = hasText("Team calendar") and panel
                compose.waitUntilAtLeastOneExists(confirmedName, 10_000)
                compose.onNode(confirmedName).assertIsDisplayed()
                assertEquals(1, fixture.renameRequests.get())
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun confirmedReadsAdoptThePristineNameAndPreserveADirtySelection() {
        ConnectorApiFixture().use { fixture ->
            withConnectors(fixture) {
                openCalendarRename()
                val fieldTag = "connector-input"
                val input = compose.onNodeWithTag(fieldTag).performClick()
                val selection = TextRange(1, 3)
                val save = compose.onNodeWithText("Save")
                fun refreshName(name: String) {
                    compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
                    fixture.setAccountName(CONNECTOR_CALENDAR_PRIMARY, name)
                    compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
                    val accountRow = hasTestTag("connector-account-$CONNECTOR_CALENDAR_PRIMARY")
                    compose.waitUntilAtLeastOneExists(accountRow and hasText(name), 10_000)
                }
                fun assertSelection() {
                    input
                        .assertIsFocused()
                        .assert(
                            SemanticsMatcher.expectValue(
                                SemanticsProperties.TextSelectionRange,
                                selection,
                            ),
                        )
                }

                input.performTextInputSelection(selection)
                refreshName("Shared calendar")
                compose.waitUntilAtLeastOneExists(
                    hasTestTag(fieldTag) and hasText("Shared calendar"),
                    10_000,
                )
                assertSelection()
                save.assertIsNotEnabled()

                input.performTextReplacement("Edited calendar")
                input.performTextInputSelection(selection)
                refreshName("Remote calendar")
                input.assertTextContains("Edited calendar")
                assertSelection()
                save.assertIsEnabled()

                assertEquals(0, fixture.renameRequests.get())
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun aLostRenameResponseKeepsTheDraftWithFieldFeedback() {
        ConnectorApiFixture().use { fixture ->
            fixture.deferRenameCommit = true
            withConnectors(fixture) {
                openCalendarRename()
                val input = compose.onNodeWithTag("connector-input").performClick()
                val draft = "Meeting calendar"
                val selection = TextRange(0, 7)
                val save = compose.onNodeWithText("Save")
                val message = "Could not save. Your changes are still here."
                input.performTextReplacement(draft)
                input.performTextInputSelection(selection)
                val saveBounds = save.getUnclippedBoundsInRoot()
                save.performClick()
                compose.waitUntilAtLeastOneExists(hasText(message), 10_000)
                input
                    .assertTextContains(draft)
                    .assertIsFocused()
                    .assert(SemanticsMatcher.expectValue(SemanticsProperties.Error, message))
                    .assert(
                        SemanticsMatcher.expectValue(
                            SemanticsProperties.TextSelectionRange,
                            selection,
                        ),
                    )
                save.assertIsEnabled()
                assertEquals(saveBounds, save.getUnclippedBoundsInRoot())
                assertEquals(1, fixture.renameRequests.get())
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun accountRefreshFeedbackKeepsTheRenameDraftAndDoesNotReplayOnReturn() {
        ConnectorApiFixture().use { fixture ->
            withConnectors(fixture) { model ->
                openCalendarRename()
                val rename = hasText("Rename") and isEnabled()
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
                val inPopup = hasAnyAncestor(isPopup())
                compose.waitUntilAtLeastOneExists(feedback and inPopup, 10_000)
                compose.onNode(feedback and !inPopup).assertDoesNotExist()
                val popup =
                    compose.onNode(isPopup() and hasAnyDescendant(feedback)).fetchSemanticsNode()
                assertTrue(
                    popup.positionOnScreen.y + popup.size.height <=
                        input.fetchSemanticsNode().positionOnScreen.y,
                )
                assertEquals(inputBounds, input.getUnclippedBoundsInRoot())
                assertEquals(saveBounds, save.assertIsEnabled().getUnclippedBoundsInRoot())
                input.assertTextContains(draft)
                val updatedDraft = "Updated calendar name"
                input.performTextReplacement(updatedDraft)
                input.assertTextContains(updatedDraft)

                cancel.performClick()
                compose.onNode(rename).assertIsDisplayed()
                compose.onNode(feedback).assertDoesNotExist()
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w412dp-h892dp")
    fun cancellingDisconnectDoesNotReplayAccountRefreshFeedback() {
        ConnectorApiFixture().use { fixture ->
            withConnectors(fixture) { model ->
                openCalendarAccount()
                val disconnect = hasText("Disconnect account") and isEnabled()
                compose.waitUntilAtLeastOneExists(disconnect, 10_000)

                fixture.accountRetryAfterSeconds = 0
                fixture.failAccountReads = true
                compose.runOnIdle { model.resume() }
                val feedback = hasText("Could not refresh connectors.")
                compose.waitUntilAtLeastOneExists(feedback, 10_000)
                compose.onNode(feedback).assertIsDisplayed()

                compose.onNode(disconnect).performClick()
                compose.onNodeWithText("Disconnect this account?").assertIsDisplayed()
                compose.onNode(feedback).assertDoesNotExist()
                compose.onNodeWithText("Cancel").performClick()
                compose.onNode(disconnect).assertIsDisplayed()
                compose.onNode(feedback).assertDoesNotExist()
            }
        }
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(qualifiers = "en-rUS-w820dp-h440dp")
    fun shortAccountRenameKeepsTheFieldAndFooterReachable() {
        ConnectorApiFixture().use { fixture ->
            withConnectors(fixture) {
                openCalendarRename()
                val rename = hasText("Rename") and isEnabled()

                val panel = compose.onNodeWithTag("connector-sheet")
                panel.assertWidthIsEqualTo(820.dp)
                compose
                    .onNode(
                        hasContentDescription("Back") and
                            hasAnyAncestor(hasTestTag("connector-sheet")),
                    )
                    .assertIsDisplayed()
                val input = compose.onNodeWithTag("connector-input")
                input.assertIsDisplayed().assertHeightIsAtLeast(56.dp)
                val cancel = compose.onNodeWithText("Cancel")
                val footer = cancel.assertIsDisplayed().getUnclippedBoundsInRoot()
                assertEquals(12.dp, panel.getUnclippedBoundsInRoot().bottom - footer.bottom)
                val save = compose.onNodeWithText("Save")
                save.assertIsNotEnabled()
                input.performTextReplacement("   ")
                save.assertIsNotEnabled()
                input.performTextReplacement("Renamed calendar")
                save.assertIsEnabled()
                assertEquals(footer, cancel.getUnclippedBoundsInRoot())
                cancel.performClick()
                compose.onNode(rename).assertIsDisplayed()
                assertEquals(0, fixture.renameRequests.get())
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
    private fun openCalendarRename() {
        openCalendarAccount()
        val rename = hasText("Rename") and isEnabled()
        compose.waitUntilAtLeastOneExists(rename, 10_000)
        compose.onNode(rename).performClick()
    }

    @OptIn(ExperimentalTestApi::class)
    private fun openCalendarAccount() {
        val calendar = hasText("Google Calendar")
        compose.waitUntilAtLeastOneExists(calendar, 10_000)
        compose.onNode(calendar).performClick()
        val account = hasTestTag("connector-account-$CONNECTOR_CALENDAR_PRIMARY")
        compose.waitUntilAtLeastOneExists(account, 10_000)
        compose.onNode(account).performClick()
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
        snapshotClock: TimeSource = MemorySnapshotClock,
        exercise: (ConnectorModel) -> Unit,
    ) {
        val store = ViewModelStore()
        try {
            val model = compose.runOnIdle {
                ViewModelProvider.create(
                        store,
                        viewModelFactory {
                            initializer {
                                ConnectorModel(
                                    fixture.service,
                                    { true },
                                    snapshotClock = snapshotClock,
                                ) {
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
