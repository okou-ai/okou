package ai.okou.android

import android.content.Context
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until

internal fun chatListRegion(context: Context) =
    By.pkg(context.packageName).desc(context.getString(R.string.chat_list_title))

internal fun UiDevice.awaitChatList(context: Context) =
    checkNotNull(wait(Until.findObject(chatListRegion(context)), 10_000)) {
        "The chat list is not visible"
    }

internal fun UiDevice.awaitKeyboardFocus(selector: BySelector) {
    // Compose can expose the text or icon on a child of the actual focus target.
    val focusedLabel = By.copy(selector).focused(true)
    val focusedControl = By.focused(true).hasChild(selector)
    val focused =
        object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice) =
                device.hasObject(focusedLabel) || device.hasObject(focusedControl)
        }
    check(wait(focused, 10_000)) { "Expected keyboard focus on $selector" }
}
