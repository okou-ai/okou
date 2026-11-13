package ai.okou.android

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = PendingAuthenticationApplication::class)
class SessionRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun initialNativeLoginPresentationDoesNotWaitForAuthentication() {
        compose.onNodeWithText("Welcome to Okou").assertExists()
        compose.onNodeWithText("Restoring your session…").assertExists()
        compose.onNodeWithTag("chat_list").assertDoesNotExist()
        compose.onNodeWithText("Settings").assertDoesNotExist()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Welcome to Okou").assertExists()
        compose.onNodeWithTag("chat_list").assertDoesNotExist()
    }
}
