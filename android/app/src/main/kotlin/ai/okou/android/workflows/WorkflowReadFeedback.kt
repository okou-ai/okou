package ai.okou.android.workflows

import ai.okou.android.PaneFeedback
import ai.okou.android.PaneFeedbackError
import ai.okou.android.PaneReadAnnouncements
import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.paneReadError
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

internal class WorkflowReadAnnouncements {
    val directory = PaneReadAnnouncements()
    val detail = PaneReadAnnouncements()
}

internal fun PaneReadAnnouncements.retainWorkflowReads(vararg failures: WorkflowReadFailure?) {
    retain(failures.mapNotNull { (it as? WorkflowReadFailure.Failed)?.feedbackOrder })
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
    notices: List<WorkflowReadNotice>,
    announced: PaneReadAnnouncements,
) {
    val snackbar = remember { SnackbarHostState() }
    announced.RetireOnExit(notices.map { it.failure.feedbackOrder })
    PaneFeedback(workflowReadErrors(notices, announced, snackbar))
    WorkflowSnackbarHost(snackbar)
}

@Composable
internal fun workflowReadErrors(
    notices: List<WorkflowReadNotice>,
    announced: PaneReadAnnouncements,
    snackbar: SnackbarHostState,
): List<PaneFeedbackError> = notices.mapNotNull {
    paneReadError(it.failure.feedbackOrder, it.message, announced, snackbar)
}

@Composable
internal fun WorkflowSnackbarHost(snackbar: SnackbarHostState, manageTimeout: Boolean = true) {
    WorkspaceFeedbackHost(
        snackbar,
        Modifier.padding(bottom = 8.dp),
        manageTimeout = manageTimeout,
        surfaceModifier = Modifier.testTag("workflow_read_snackbar"),
        showDismissAction = true,
    )
}
