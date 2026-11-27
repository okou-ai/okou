package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import kotlinx.coroutines.delay

internal val ChatRowAction.recoversInBackground: Boolean
    get() =
        when (this) {
            ChatRowAction.Archive,
            ChatRowAction.Unarchive,
            ChatRowAction.Pin,
            ChatRowAction.Unpin,
            ChatRowAction.MovePinUp,
            ChatRowAction.MovePinDown,
            ChatRowAction.Mute,
            ChatRowAction.Unmute,
            ChatRowAction.MarkRead,
            ChatRowAction.MarkUnread,
            ChatRowAction.MoveProject -> true
            else -> false
        }

/** A pin reorder shares its retry budget across the individual rank writes. */
internal class ChatWriteRetries {
    private var remaining = 2

    suspend fun <T> run(write: suspend (retrying: Boolean) -> T): T {
        var retrying = false
        while (true) {
            try {
                return write(retrying)
            } catch (error: ApiFailure.Network) {
                if (!error.connectionFailed || remaining == 0) throw error
                remaining--
            }
            delay(3_000)
            retrying = true
        }
    }
}
