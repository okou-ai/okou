package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.SettingsSheet
import ai.okou.android.SettingsSheetScroll
import ai.okou.android.WithButtonFocusOutline
import ai.okou.android.workflows.rememberWorkflowReturnFocus
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

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
    val hidden = Modifier.clearAndSetSemantics {}.alpha(0f)
    val live = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
    val useEnabled = workflow.canUse && canStartDraft && !pending
    var restoreUseFocus by remember(workflow.id) { mutableStateOf(false) }
    SettingsSheet(title = workflow.title, onDismiss = onClose, scroll = SettingsSheetScroll.Panel) {
        val useFocus =
            rememberWorkflowReturnFocus(restoreUseFocus && failed, useEnabled) {
                restoreUseFocus = false
            }
        workflow.description
            ?.takeIf { it.isNotBlank() }
            ?.let {
                Text(
                    it,
                    color = colors.onSurfaceVariant,
                    style =
                        MaterialTheme.typography.bodyMedium.copy(
                            fontSize = 13.sp,
                            lineHeight = 20.sp,
                        ),
                )
            }
        // Measure the localized failure in the idle state so readback cannot move the actions.
        Text(
            stringResource(
                if (workflow.canUse) R.string.workflow_draft_unavailable
                else R.string.chat_search_workflow_shadowed,
            ),
            modifier = if (failed || !workflow.canUse) live else hidden,
            color = if (failed && workflow.canUse) colors.error else colors.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
        WithButtonFocusOutline(colors.onPrimary) {
            Button(
                onClick = {
                    restoreUseFocus = useFocus.keyboardFocused
                    onUse()
                },
                enabled = useEnabled,
                modifier = action.then(useFocus.modifier).then(if (pending) live else Modifier),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(
                        stringResource(R.string.chat_search_workflow_add_draft),
                        modifier = if (pending) hidden else Modifier,
                        textAlign = TextAlign.Center,
                    )
                    Text(
                        stringResource(R.string.chat_search_workflow_opening_draft),
                        modifier = if (pending) Modifier else hidden,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
        WithButtonFocusOutline(colors.onSurface) {
            TextButton(onClick = onOpenDetails, enabled = !pending, modifier = action) {
                Text(stringResource(R.string.chat_search_workflow_details))
            }
        }
    }
}
