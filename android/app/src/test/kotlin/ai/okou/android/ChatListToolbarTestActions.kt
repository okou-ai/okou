package ai.okou.android

import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick

internal fun ComposeTestRule.openChatListSettings(
    more: String = "More actions",
    settings: String = "Settings",
) {
    onNodeWithContentDescription(more).performClick()
    onNodeWithText(settings).performClick()
}
