package ai.okou.android.connectors

import ai.okou.android.ContentReadFailure
import ai.okou.android.ContentReadFailureLayout
import ai.okou.android.PaneFeedback
import ai.okou.android.PaneReadAnnouncements
import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.chat.ContentReadFeedback
import ai.okou.android.paneReadError
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

internal data class ConnectorReadNotice(val round: Long, @StringRes val message: Int)

internal fun ConnectorRead<*>.notice(@StringRes message: Int = R.string.connector_refresh_failed) =
    failureRound?.let {
        ConnectorReadNotice(it, message)
    }

@Composable
internal fun rememberConnectorReadFeedback(
    notice: ConnectorReadNotice?,
    announcements: PaneReadAnnouncements,
): SnackbarHostState = rememberConnectorReadFeedback(listOfNotNull(notice), announcements)

@Composable
internal fun rememberConnectorReadFeedback(
    notices: List<ConnectorReadNotice>,
    announcements: PaneReadAnnouncements,
): SnackbarHostState {
    val snackbar = remember { SnackbarHostState() }
    announcements.RetireOnExit(notices.map { it.round })
    PaneFeedback(
        notices.mapNotNull { paneReadError(it.round, it.message, announcements, snackbar) },
    )
    return snackbar
}

@Composable
internal fun ConnectorReadFeedbackHost(
    notices: List<ConnectorReadNotice>,
    announcements: PaneReadAnnouncements,
    modifier: Modifier = Modifier,
) {
    val snackbar = rememberConnectorReadFeedback(notices, announcements)
    Box(modifier) { WorkspaceFeedbackHost(snackbar, Modifier) }
}

@Composable
internal fun ConnectorReadFailureContent(
    failure: ConnectorReadFailure,
    @StringRes unavailable: Int,
    modifier: Modifier,
    failureLayout: ContentReadFailureLayout = ContentReadFailureLayout.Viewport,
) {
    if (failure == ConnectorReadFailure.Unavailable) {
        ConnectorReadError(unavailable, modifier)
    } else {
        ContentReadFailure(
            R.string.chat_list_first_load_failed,
            modifier.fillMaxWidth(),
            failureLayout = failureLayout,
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
