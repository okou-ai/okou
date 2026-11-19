package ai.okou.android

import android.content.Context
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until

internal fun chatListRegion(context: Context) =
    By.pkg(context.packageName).desc(context.getString(R.string.chat_list_title))

internal fun UiDevice.awaitChatList(context: Context) =
    checkNotNull(wait(Until.findObject(chatListRegion(context)), 10_000)) {
        "The chat list is not visible"
    }
