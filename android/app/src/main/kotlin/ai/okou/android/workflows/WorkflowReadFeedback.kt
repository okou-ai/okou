package ai.okou.android.workflows

import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackHost
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

internal class WorkflowReadAnnouncements {
    val directory = mutableSetOf<WorkflowReadFailure.Failed>()
    val detail = mutableSetOf<WorkflowReadFailure.Failed>()
}

internal data class WorkflowReadNotice(
    val failure: WorkflowReadFailure.Failed,
    @StringRes val message: Int,
)

internal fun WorkflowReadFailure?.notice(
    @StringRes message: Int = R.string.workflow_refresh_failed,
): WorkflowReadNotice? =
    (this as? WorkflowReadFailure.Failed)?.let { WorkflowReadNotice(it, message) }

internal fun WorkflowState.connectionReadNotice() =
    connectionsFailure.notice(
        if (connections == null) R.string.connector_accounts_failed
        else R.string.workflow_refresh_failed,
    )

@Composable
internal fun WorkflowReadFeedbackHost(
    notice: WorkflowReadNotice?,
    announced: MutableSet<WorkflowReadFailure.Failed>,
    actionSnackbar: SnackbarHostState? = null,
) {
    val snackbar = remember { SnackbarHostState() }
    val activeActionSnackbar = actionSnackbar?.takeIf { it.currentSnackbarData != null }
    val message = notice?.let { stringResource(it.message) }
    LaunchedEffect(notice?.failure, message, activeActionSnackbar) {
        if (
            activeActionSnackbar == null &&
                notice != null &&
                message != null &&
                announced.add(notice.failure)
        ) {
            snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
        }
    }
    WorkspaceFeedbackHost(
        activeActionSnackbar ?: snackbar,
        Modifier.padding(bottom = 8.dp),
        surfaceModifier =
            if (activeActionSnackbar == null) Modifier.testTag("workflow_read_snackbar")
            else Modifier,
    )
}
