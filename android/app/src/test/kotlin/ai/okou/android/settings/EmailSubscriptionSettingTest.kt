package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.OkouTheme
import ai.okou.android.R
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.EmailSubscription
import ai.okou.android.api.generated.EmailSubscriptionDeliveryStatus
import ai.okou.android.auth.WorkspaceSession
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "de-rDE-w320dp-h780dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class EmailSubscriptionSettingTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val owner = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val api = ChatListApiFixture()
    private val read = CompletableDeferred<Unit>()
    private val write = CompletableDeferred<Unit>()

    @After
    fun closeOwner() {
        owner.cancel()
        api.close()
    }

    @Test
    fun initialReadKeepsTheDescriptionInPlaceAtLargeFont() {
        openSheet()
        compose.mainClock.advanceTimeBy(300)
        val loading = compose.onNodeWithContentDescription(text(R.string.settings_email_refreshing))
        val description = compose.onNodeWithText(text(R.string.settings_email_scope))
        val before = description.assertIsDisplayed().getUnclippedBoundsInRoot()
        val placeholder = loading.assertIsDisplayed().getUnclippedBoundsInRoot()
        compose.onNodeWithText(text(R.string.settings_email_receive)).assertDoesNotExist()

        compose.runOnIdle { read.complete(Unit) }

        val row = switch().assertIsDisplayed().assertIsOff().assertIsEnabled()
        assertEquals(placeholder, row.getUnclippedBoundsInRoot())
        assertEquals(before, description.getUnclippedBoundsInRoot())
        loading.assertDoesNotExist()
    }

    @Test
    fun wrappedWriteFeedbackKeepsTheSwitchInPlaceAndRollsBackOnRejection() {
        read.complete(Unit)
        openSheet()
        val row = switch().assertIsOff().assertIsEnabled()
        val before = row.getUnclippedBoundsInRoot()
        val saving = compose.onNodeWithText(text(R.string.settings_email_saving))
        val failed = compose.onNodeWithText(text(R.string.settings_email_save_failed))
        val unconfirmed = compose.onNodeWithText(text(R.string.settings_email_save_unconfirmed))
        saving.assertDoesNotExist()
        failed.assertDoesNotExist()
        unconfirmed.assertDoesNotExist()

        row.performClick().assertIsOn().assertIsNotEnabled()
        saving.assertIsDisplayed()
        val layout = mutableListOf<TextLayoutResult>()
        saving.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layout) }
        assertTrue(layout.single().lineCount > 1)
        assertEquals(before, row.getUnclippedBoundsInRoot())
        failed.assertDoesNotExist()
        unconfirmed.assertDoesNotExist()

        compose.runOnIdle { write.complete(Unit) }
        row.assertIsOff().assertIsEnabled()
        failed.assertIsDisplayed()
        assertEquals(before, row.getUnclippedBoundsInRoot())
        saving.assertDoesNotExist()
        unconfirmed.assertDoesNotExist()
    }

    private fun openSheet() {
        RuntimeEnvironment.setFontScale(2f)
        compose.activityRule.scenario.recreate()
        val service =
            object : WorkspaceSession by api.service {
                override suspend fun emailSubscription(): EmailSubscription {
                    read.await()
                    return EmailSubscription(
                        false,
                        "qa@x.test",
                        EmailSubscriptionDeliveryStatus.AVAILABLE,
                    )
                }

                override suspend fun updateEmailSubscription(subscribed: Boolean): Nothing {
                    check(subscribed)
                    write.await()
                    throw ApiFailure.Http(400, null, null, null)
                }
            }
        val model =
            EmailSubscriptionSettings(
                owner,
                service,
                api.identity,
                cache = null,
                authorized = { true },
                onSessionFailure = {},
                nowMillis = System::currentTimeMillis,
                notice = {},
            )
        compose.setContent { OkouTheme(dark = false) { EmailSubscriptionSetting(model) {} } }
        compose.onNodeWithText(text(R.string.settings_email_updates)).performClick()
    }

    private fun text(id: Int) = compose.activity.getString(id)

    private fun switch() =
        compose.onNode(hasText(text(R.string.settings_email_receive)) and isToggleable())
}
