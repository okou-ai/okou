package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ProactiveSettingsApiFixture
import ai.okou.android.R
import ai.okou.android.TestOkouApplication
import android.os.Looper
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
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
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
    fun missingTimezoneOpensTheNativePickerWithoutSendingAMorningBriefChange() {
        val fixture = app.proactive
        fixture.morningNeedsTimezone = true
        openOverview()
        compose.onNodeWithText(title).performScrollTo().performClick()
        compose.waitUntilExactlyOneExists(hasText("Morning Brief") and nativeSwitch, 10_000)
        compose.onNode(hasText("Morning Brief") and nativeSwitch).assertIsNotEnabled().assertIsOff()
        compose.onNodeWithText("Time zone").assertIsDisplayed().performClick()
        compose.onNodeWithText(app.getString(R.string.settings_timezone_hint)).assertIsDisplayed()
        assertTrue(fixture.writes.isEmpty())
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
