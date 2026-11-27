package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.SettingsApiFixture
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.jsonResponse
import ai.okou.android.openChatListSettings
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.ViewModelProvider
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

class SettingsFeedbackApplication : TestOkouApplication() {
    internal val transport = ChatListApiFixture()
    internal val settings = SettingsApiFixture(transport)
    internal val failAccounts = AtomicBoolean(false)

    override fun onCreate() {
        val original = transport.commandResponse
        transport.commandResponse = { request ->
            if (
                failAccounts.get() &&
                    request.requestUrl?.encodedPath == "/api/me/3rd-party-subscriptions"
            )
                jsonResponse("""{"error":{"code":"UNAVAILABLE","message":"Unavailable"}}""")
                    .setResponseCode(400)
            else original(request)
        }
        chatService = transport.service
        recoveryService = transport.service
        super.onCreate()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w400dp-h800dp",
    application = SettingsFeedbackApplication::class,
)
class SettingsFeedbackRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @After
    fun closeTransport() {
        val app = compose.activity.application as SettingsFeedbackApplication
        compose.activityRule.scenario.close()
        app.transport.close()
    }

    @Test
    fun rejectedAccountSwitchIsShownBeforeTheFailedRefresh() {
        val app = compose.activity.application as SettingsFeedbackApplication
        compose.waitUntilExactlyOneExists(hasContentDescription("More actions"), 10_000)
        compose.openChatListSettings()
        compose.onNodeWithText("Model accounts").performScrollTo().performClick()
        val account = hasText("work@example.com")
        compose.waitUntilExactlyOneExists(account, 10_000)
        val settings = compose.runOnIdle {
            checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready,
                )
                .settings
        }
        app.settings.activationStatus = 400
        app.failAccounts.set(true)
        compose.onNode(account).assertIsEnabled().performClick()
        compose.waitUntil("Both account failures reach the pane", 10_000) {
            compose.runOnIdle { settings.uiState.value.accounts.refreshFailure != null }
        }

        val rejected =
            compose.onNodeWithText(app.getString(R.string.settings_account_switch_failed))
        val refresh =
            compose.onNodeWithText(app.getString(R.string.settings_accounts_update_failed))
        rejected.assertIsDisplayed()
        refresh.assertDoesNotExist()
        compose.mainClock.advanceTimeBy(5_000)
        rejected.assertDoesNotExist()
        refresh.assertIsDisplayed()
        compose.mainClock.advanceTimeBy(5_000)
        refresh.assertDoesNotExist()
        compose.onNode(account).assertIsDisplayed()

        compose.onNodeWithContentDescription("Back").performClick()
        app.failAccounts.set(false)
        compose.onNodeWithText("Model accounts").performScrollTo().performClick()
        compose.onNode(account).assertIsDisplayed()
        refresh.assertDoesNotExist()
    }
}
