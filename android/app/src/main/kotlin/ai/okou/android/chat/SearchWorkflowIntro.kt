package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.SettingsSheet
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

@Composable
internal fun SearchWorkflowIntro(
    workflow: SearchWorkflowHit,
    canStartDraft: Boolean,
    pending: Boolean,
    failed: Boolean,
    onClose: () -> Unit,
    onUse: () -> Unit,
    onOpenDetails: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val action = Modifier.heightIn(min = 48.dp)
    val shape = RoundedCornerShape(12.dp)
    val padding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
    SettingsSheet(title = workflow.title, onDismiss = onClose) {
        workflow.description
            ?.takeIf { it.isNotBlank() }
            ?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
        Button(
            onClick = onUse,
            enabled = workflow.canUse && canStartDraft && !pending,
            modifier = action,
            shape = shape,
            contentPadding = padding,
        ) {
            Text(stringResource(R.string.chat_search_workflow_add_draft))
        }
        if (failed) {
            Text(
                stringResource(R.string.workflow_draft_unavailable),
                color = colors.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        if (!workflow.canUse) {
            Text(
                stringResource(R.string.chat_search_workflow_shadowed),
                color = colors.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        TextButton(
            onClick = onOpenDetails,
            enabled = !pending,
            modifier = action,
            shape = shape,
            contentPadding = padding,
            colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface),
        ) {
            Text(stringResource(R.string.chat_search_workflow_details))
        }
    }
}
