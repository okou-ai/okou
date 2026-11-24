package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ProactiveSettingsApiFixture
import ai.okou.android.R
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.preferences.timezoneOptions
import ai.okou.android.testPreferences
import android.icu.util.TimeZone
import android.os.Looper
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToKey
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.time.Instant
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

class ProactiveSettingsTestApplication : TestOkouApplication() {
    internal lateinit var transport: ChatListApiFixture
    internal lateinit var proactive: ProactiveSettingsApiFixture

    override fun onCreate() {
        transport = ChatListApiFixture()
        proactive = ProactiveSettingsApiFixture(transport)
        chatService = transport.service
        proactivePreferencesService = transport.service.proactivePreferences
        initialPreferences = testPreferences().copy(timezone = "Asia/Shanghai")
        super.onCreate()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = ProactiveSettingsTestApplication::class)
class ProactiveSettingsPageTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app
        get() = compose.activity.application as ProactiveSettingsTestApplication

    private val title = "Proactive services"
    private val nativeSwitch = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch)

    @After
    fun cleanup() {
        val application = app
        compose.activityRule.scenario.close()
        application.transport.close()
    }

    @Test
    fun firstDisplayAndReturnKeepSettingsScrollAndKeyboardFocus() {
        val fixture = app.proactive
        val release = CountDownLatch(1)
        fixture.beforeMorningRead = { check(release.await(10, TimeUnit.SECONDS)) }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            openOverview()
            assertTrue(fixture.reads.isEmpty())
            val entry = compose.onNodeWithText(title).performScrollTo()
            entry.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            val entryBounds = entry.assertIsFocused().getUnclippedBoundsInRoot()
            entry.performKeyInput { pressKey(Key.Enter) }
            compose.onNodeWithText(title).assertIsDisplayed()
            compose.onNodeWithText("These settings apply in “Workspace A”.").assertIsDisplayed()
            compose.waitUntil("Morning Brief request reaches the fixture", 10_000) {
                // The cache read resumes on Android's main looper, outside the Compose test clock.
                shadowOf(Looper.getMainLooper()).idle()
                "morning-brief" in fixture.reads
            }
            compose.onNodeWithText("Morning Brief").assertDoesNotExist()

            release.countDown()
            val morning = compose.onNode(hasText("Morning Brief") and nativeSwitch)
            compose.waitUntilExactlyOneExists(hasText("Morning Brief") and nativeSwitch, 10_000)
            morning.assertIsOff()
            val bounds = morning.getUnclippedBoundsInRoot()
            assertEquals(24.dp, bounds.left)
            assertTrue(bounds.bottom - bounds.top >= 72.dp)
            compose.onNodeWithContentDescription("Back").performClick()
            entry.assertIsFocused().assertIsDisplayed()
            assertEquals(entryBounds, entry.getUnclippedBoundsInRoot())
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithContentDescription("Settings").assertIsDisplayed()
        } finally {
            release.countDown()
            instrumentation.setInTouchMode(true)
        }
    }

    @Test
    fun missingTimezoneOpensTheCurrentSelectionAndSavesAStandardRegionOutsideTheOldList() {
        val fixture = app.proactive
        fixture.morningNeedsTimezone = true
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            openOverview()
            compose.onNodeWithText(title).performScrollTo().performClick()
            compose.waitUntilExactlyOneExists(hasText("Morning Brief") and nativeSwitch, 10_000)
            compose
                .onNode(hasText("Morning Brief") and nativeSwitch)
                .assertIsNotEnabled()
                .assertIsOff()
            val trigger = compose.onNodeWithText("Time zone").assertIsDisplayed()
            trigger.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            trigger.performKeyInput { pressKey(Key.Enter) }
            val note = compose.onNodeWithText(app.getString(R.string.settings_timezone_hint))
            val heading =
                compose.onNode(
                    hasText("Time zone") and
                        SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading),
                )
            val headingBounds = heading.assertIsDisplayed().getUnclippedBoundsInRoot()
            val noteBounds = note.assertIsDisplayed().getUnclippedBoundsInRoot()
            compose
                .onNode(hasText("Shanghai (UTC+8)") and isSelectable())
                .assertIsDisplayed()
                .assertIsSelected()
                .assertIsFocused()

            val kathmandu = TimeZone.getCanonicalID("Asia/Kathmandu")
            compose.onNode(hasScrollToIndexAction()).performScrollToKey(kathmandu)
            assertEquals(headingBounds, heading.getUnclippedBoundsInRoot())
            assertEquals(noteBounds, note.getUnclippedBoundsInRoot())
            val choice = compose.onNode(hasText("Kathmandu (UTC+5:45)") and isSelectable())
            choice.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            fixture.morningNeedsTimezone = false
            choice.performKeyInput { pressKey(Key.Enter) }
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    app.snapshotApiPreferences().values.any { it.timezone == kathmandu }
                }
            }
            val morning = hasText("Morning Brief") and nativeSwitch and isEnabled()
            compose.waitUntilExactlyOneExists(morning, 10_000)
            trigger.assertDoesNotExist()
            compose.onNode(morning).assertIsFocused()
            assertTrue(fixture.writes.isEmpty())
        } finally {
            instrumentation.setInTouchMode(true)
        }
    }

    @Test
    fun confirmingTimezoneReturnsFocusToSuggestionsWhenOnlySuggestionsNeededIt() {
        val fixture = app.proactive
        fixture.suggestionsEnabled = true
        fixture.cardsEnabled = true
        fixture.suggestionsNeedsTimezone = true
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            openOverview()
            compose.onNodeWithText(title).performScrollTo().performClick()
            compose.waitUntilExactlyOneExists(hasText("Time zone"), 10_000)
            val trigger = compose.onNodeWithText("Time zone")
            trigger.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            trigger.performKeyInput { pressKey(Key.Enter) }
            val choice = compose.onNode(hasText("Shanghai (UTC+8)") and isSelectable())
            fixture.suggestionsNeedsTimezone = false
            choice.assertIsFocused().performKeyInput { pressKey(Key.Enter) }
            compose.waitUntilDoesNotExist(hasText("Time zone"), 10_000)
            compose.onNode(hasText("Suggestions") and nativeSwitch).assertIsFocused()
        } finally {
            instrumentation.setInTouchMode(true)
        }
    }

    @Test
    fun confirmingTimezoneReturnsFocusToMorningBriefWhenSuggestionsDisappears() {
        val fixture = app.proactive
        fixture.suggestionsNeedsTimezone = true
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            openOverview()
            compose.onNodeWithText(title).performScrollTo().performClick()
            val trigger = compose.onNodeWithText("Time zone")
            compose.waitUntilExactlyOneExists(hasText("Time zone"), 10_000)
            trigger.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            trigger.performKeyInput { pressKey(Key.Enter) }
            fixture.suggestionsEligible = false
            compose
                .onNode(hasText("Shanghai (UTC+8)") and isSelectable())
                .assertIsFocused()
                .performKeyInput { pressKey(Key.Enter) }
            compose.waitUntilDoesNotExist(hasText("Time zone"), 10_000)
            compose.onNode(hasText("Suggestions") and nativeSwitch).assertDoesNotExist()
            compose.onNode(hasText("Morning Brief") and nativeSwitch).assertIsFocused()
        } finally {
            instrumentation.setInTouchMode(true)
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w720dp-h800dp")
    fun intermediateWidthUsesTheMaterialBottomSheetLimit() {
        openProactiveWithMissingTimezone()
        compose.onNodeWithText("Time zone").performClick()
        val choice = compose.onNode(hasText("Shanghai (UTC+8)") and isSelectable())
        val bounds = choice.assertIsDisplayed().getUnclippedBoundsInRoot()
        assertEquals(608.dp, bounds.right - bounds.left)
    }

    @Test
    fun rejectedTimezoneRestoresTheRowAndTheNextSelectionClearsFeedback() {
        app.preferenceWrite = { update, save ->
            if (update.timezone == TimeZone.getCanonicalID("Asia/Kathmandu")) {
                throw ApiFailure.Http(400, "BAD_REQUEST", null, null)
            }
            save().also { app.proactive.morningNeedsTimezone = false }
        }
        openProactiveWithMissingTimezone()
        chooseKathmandu()

        val notice = hasText(app.getString(R.string.settings_timezone_save_rejected))
        compose.waitUntilExactlyOneExists(notice, 10_000)
        val trigger = compose.onNode(hasText("Time zone") and hasText("Shanghai (UTC+8)"))
        trigger.assertIsDisplayed().assertIsEnabled().performClick()
        compose.onNode(hasText("Shanghai (UTC+8)") and isSelectable()).assertIsSelected()
        compose.onNode(hasText("Shanghai (UTC+8)") and isSelectable()).performClick()
        compose.waitUntilExactlyOneExists(
            hasText("Morning Brief") and nativeSwitch and isEnabled(),
            10_000,
        )
        compose.onNode(notice).assertDoesNotExist()
    }

    @Test
    fun savedTimezoneKeepsScheduleRetryAfterThePickerDisappears() {
        var failedSchedule = false
        app.preferenceWrite = { _, save ->
            save().also {
                app.proactive.morningNeedsTimezone = false
                if (!failedSchedule) {
                    failedSchedule = true
                    throw ApiFailure.Http(409, "CONFLICT", null, null)
                }
            }
        }
        openProactiveWithMissingTimezone()
        chooseKathmandu()

        compose.waitUntilExactlyOneExists(
            hasText("Morning Brief") and nativeSwitch and isEnabled(),
            10_000,
        )
        compose.onNodeWithText("Time zone").assertDoesNotExist()
        val notice = hasText(app.getString(R.string.settings_timezone_schedule_update_failed))
        compose.onNode(notice).assertIsDisplayed()
        compose.onNodeWithText(app.getString(R.string.retry)).performClick()
        compose.waitUntilDoesNotExist(notice, 10_000)
        compose.runOnIdle {
            assertTrue(
                app.snapshotApiPreferences().values.any {
                    it.timezone == TimeZone.getCanonicalID("Asia/Kathmandu")
                },
            )
        }
    }

    @Test
    fun timezoneOrderAccountsForDaylightSavingAndSortsEqualOffsetsByCity() {
        val utcName = app.getString(R.string.settings_timezone_utc)
        val winter =
            timezoneOptions(
                "Europe/London",
                Locale.US,
                utcName,
                Instant.parse("2026-01-15T12:00:00Z").toEpochMilli(),
            )
        val summer =
            timezoneOptions(
                "Europe/London",
                Locale.US,
                utcName,
                Instant.parse("2026-07-15T12:00:00Z").toEpochMilli(),
            )
        val londonInWinter = winter.indexOfFirst { it.id == "Europe/London" }
        val monroviaInWinter = winter.indexOfFirst { it.id == "Africa/Monrovia" }
        val londonInSummer = summer.indexOfFirst { it.id == "Europe/London" }
        val monroviaInSummer = summer.indexOfFirst { it.id == "Africa/Monrovia" }
        assertEquals(0, winter[londonInWinter].offsetMinutes)
        assertEquals(0, winter[monroviaInWinter].offsetMinutes)
        assertTrue(londonInWinter < monroviaInWinter)
        assertEquals(60, summer[londonInSummer].offsetMinutes)
        assertEquals(0, summer[monroviaInSummer].offsetMinutes)
        assertTrue(monroviaInSummer < londonInSummer)
        val offsets = summer.mapNotNull { it.offsetMinutes }
        assertEquals(offsets.sorted(), offsets)
    }

    @Test
    @Config(sdk = [24, 35])
    fun savedIanaAliasUsesTheLocalizedNameOfItsCanonicalZone() {
        val saved = "Asia/Kathmandu"
        val canonical = TimeZone.getCanonicalID(saved)
        val options = timezoneOptions(saved, Locale.SIMPLIFIED_CHINESE, "协调世界时")
        assertTrue(options.any { it.id == "Pacific/Chatham" })
        assertTrue(options.any { it.id == "Etc/UTC" })
        val matching = options.filter { TimeZone.getCanonicalID(it.id) == canonical }
        assertEquals(saved, matching.single().id)
        assertEquals("加德满都", matching.single().name)
    }

    @Test
    fun partialSuggestionsUseTheLinkedChoice() {
        val fixture = app.proactive
        fixture.cardsEnabled = true
        openOverview()
        compose.onNodeWithText(title).performScrollTo().performClick()
        compose.waitUntilExactlyOneExists(hasText("Partially enabled"), 10_000)
        compose.onNodeWithText("Partially enabled").performClick()
        compose.onNodeWithText("Currently only delivers suggestion cards.").assertIsDisplayed()
        compose.onNodeWithText("Turn both on").performClick()
        compose.waitUntilExactlyOneExists(hasText("Suggestions") and nativeSwitch, 10_000)
        compose.onNode(hasText("Suggestions") and nativeSwitch).assertIsOn()
        compose.waitUntil(10_000) { fixture.cardsEnabled && fixture.suggestionsEnabled }
        assertEquals(listOf(ProactiveSetting.Suggestions to true), fixture.writes)
    }

    private fun openOverview() {
        compose.waitUntilExactlyOneExists(hasContentDescription("Settings"), 10_000)
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.waitUntilExactlyOneExists(hasText(title), 10_000)
    }

    private fun openProactiveWithMissingTimezone() {
        app.proactive.morningNeedsTimezone = true
        openOverview()
        compose.onNodeWithText(title).performScrollTo().performClick()
        compose.waitUntilExactlyOneExists(hasText("Morning Brief") and nativeSwitch, 10_000)
    }

    private fun chooseKathmandu() {
        compose.onNodeWithText("Time zone").performClick()
        compose
            .onNode(hasScrollToIndexAction())
            .performScrollToKey(TimeZone.getCanonicalID("Asia/Kathmandu"))
        compose.onNode(hasText("Kathmandu (UTC+5:45)") and isSelectable()).performClick()
    }
}
