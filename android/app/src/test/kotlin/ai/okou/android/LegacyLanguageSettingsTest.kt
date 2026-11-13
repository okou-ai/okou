package ai.okou.android

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.core.app.LocaleManagerCompat
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24], qualifiers = "en-rUS", application = TestOkouApplication::class)
class LegacyLanguageSettingsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun applicationLanguageChangesUseTheNativeCompatibilityPathAndRecreateTheList() {
        compose.onNodeWithText("Chats").assertExists()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("English").performScrollTo().performClick()
        compose.onNodeWithText("日本語").performScrollTo().performClick()
        compose.waitForIdle()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("設定").assertExists()
        org.junit.Assert.assertEquals(
            "en",
            LocaleManagerCompat.getSystemLocales(compose.activity)[0]?.language,
        )
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText(compose.activity.getString(R.string.chat_list_title)).assertExists()
    }
}
