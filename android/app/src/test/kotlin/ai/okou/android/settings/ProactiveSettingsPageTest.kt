package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ProactiveSettingsApiFixture
import ai.okou.android.R
import ai.okou.android.TestOkouApplication
import ai.okou.android.preferences.timezoneOptions
import ai.okou.android.testPreferences
import android.icu.util.TimeZone
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
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
            compose.waitUntil(10_000) { "morning-brief" in fixture.reads }
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
            compose
                .onNodeWithText(app.getString(R.string.settings_timezone_hint))
                .assertIsDisplayed()
            compose
                .onNode(hasText("Shanghai (UTC+8)") and isSelectable())
                .assertIsDisplayed()
                .assertIsSelected()
                .assertIsFocused()

            val kathmandu = TimeZone.getCanonicalID("Asia/Kathmandu")
            val options =
                timezoneOptions(
                    "Asia/Shanghai",
                    Locale.US,
                    app.getString(R.string.settings_timezone_utc),
                )
            val offsets = options.mapNotNull { it.offsetMinutes }
            assertEquals(offsets.sorted(), offsets)
            val destination = options.indexOfFirst { it.id == kathmandu }
            assertTrue(destination >= 0)
            compose.onNode(hasScrollToIndexAction()).performScrollToIndex(destination)
            compose
                .onNode(
                    hasText("Time zone") and
                        SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading),
                )
                .assertIsDisplayed()
            compose.onNode(hasText("Kathmandu (UTC+5:45)") and isSelectable()).performClick()
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    app.snapshotApiPreferences().values.any { it.timezone == kathmandu }
                }
            }
            assertTrue(fixture.writes.isEmpty())
        } finally {
            instrumentation.setInTouchMode(true)
        }
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
}
