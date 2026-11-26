package ai.okou.android.artifacts

import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.WorkspaceFeedbackTimeout
import androidx.compose.foundation.layout.Box
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

@Composable
internal fun rememberArtifactRefreshFeedback(
    model: ArtifactCatalogModel,
    query: ArtifactQuery,
    state: ArtifactCatalogState?,
): SnackbarHostState {
    val snackbar = remember(model, query) { SnackbarHostState() }
    val failure = state?.takeIf { it.query == query }?.refreshFailure
    val message = stringResource(R.string.artifact_catalog_refresh_failed)
    LaunchedEffect(snackbar, failure) {
        if (failure != null) snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
    }
    WorkspaceFeedbackTimeout(snackbar)
    return snackbar
}

@Composable
internal fun ArtifactRefreshFeedback(state: SnackbarHostState, modifier: Modifier) {
    Box(modifier) {
        WorkspaceFeedbackHost(
            state,
            Modifier.padding(bottom = 8.dp),
            manageTimeout = false,
            surfaceModifier = Modifier.testTag("artifact_refresh_feedback"),
        )
    }
}
