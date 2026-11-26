package ai.okou.android.connectors

import ai.okou.android.ContentReadFailure
import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.chat.ContentReadFeedback
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

internal data class ConnectorReadNotice(val round: Long, @StringRes val message: Int)

internal fun ConnectorRead<*>.notice(@StringRes message: Int = R.string.connector_refresh_failed) =
    failureRound?.let {
        ConnectorReadNotice(it, message)
    }

internal class ConnectorReadAnnouncements {
    private var lastRound = 0L

    fun announce(round: Long): Boolean {
        if (round <= lastRound) return false
        lastRound = round
        return true
    }
}

@Composable
internal fun ConnectorReadFeedbackHost(
    notice: ConnectorReadNotice?,
    announcements: ConnectorReadAnnouncements,
    modifier: Modifier = Modifier,
) {
    val snackbar = remember { SnackbarHostState() }
    val message = notice?.let { stringResource(it.message) }
    LaunchedEffect(notice, message) {
        if (notice != null && message != null && announcements.announce(notice.round)) {
            snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
        }
    }
    Box(modifier) { WorkspaceFeedbackHost(snackbar, Modifier) }
}

@Composable
internal fun ConnectorReadFailureContent(
    failure: ConnectorReadFailure,
    @StringRes unavailable: Int,
    modifier: Modifier,
    inPanel: Boolean = false,
) {
    if (failure == ConnectorReadFailure.Unavailable) {
        ConnectorReadError(unavailable, modifier)
    } else {
        ContentReadFailure(
            R.string.chat_list_first_load_failed,
            modifier.fillMaxWidth(),
            inPanel = inPanel,
        )
    }
}

@Composable
internal fun ConnectorReadError(@StringRes message: Int, modifier: Modifier = Modifier) {
    ContentReadFeedback(
        message,
        modifier.fillMaxWidth().padding(start = 12.dp, top = 24.dp, end = 12.dp),
    )
}
