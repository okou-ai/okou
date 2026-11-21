package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.api.generated.ResetSubscriptionResultOutcome
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun AssistantRecoveryPanel(
    model: AssistantRecoveryModel,
    composer: ChatComposerModel,
    target: ComposerTarget,
    failureId: String,
    offline: Boolean,
) {
    val read by model.uiState.collectAsStateWithLifecycle()
    val input by composer.uiState.collectAsStateWithLifecycle()
    if (read.selection?.threadId != target.threadId || read.selection?.failureId != failureId)
        return
    val entry = input.entry(target)
    val busy =
        offline || target.key in input.busy || input.persistence != ComposerPersistence.Durable
    val attempt = entry.recovery?.takeIf { it.selection == read.selection }
    val unresolvedOther =
        entry.recovery?.let {
            it.selection != read.selection && it.reset != null && it.outcome == null
        } == true
    val unknownReset = attempt?.reset != null && attempt.outcome == null
    Surface(
        Modifier.fillMaxWidth().padding(top = 8.dp),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            if (read.phase == ChatReadPhase.Loading) Text(stringResource(R.string.recovery_loading))
            if (read.phase == ChatReadPhase.Failed)
                Text(stringResource(R.string.recovery_read_failed))
            val data = read.data
            if (data != null) {
                val confirmedReset =
                    attempt?.reset?.accountId == data.account?.id &&
                        attempt?.reset != null &&
                        attempt.outcome != null &&
                        attempt.outcome != ResetSubscriptionResultOutcome.NOCREDIT
                data.account?.accountEmail?.let { Text(it) }
                data.resetTimes.forEach { Text(it) }
                data.account?.subscriptionResetCredits?.let {
                    Text(stringResource(R.string.recovery_credits, it))
                }
                data.billing?.let {
                    Text(stringResource(R.string.recovery_billing, it.credits.toString()))
                }
                if (!data.classification.canContinue && data.billing == null)
                    Text(stringResource(R.string.recovery_needs_changes))
                if (unknownReset || unresolvedOther)
                    Text(stringResource(R.string.recovery_reset_unknown))
                if (attempt?.outcome == ResetSubscriptionResultOutcome.NOCREDIT)
                    Text(stringResource(R.string.recovery_no_credit))
                if (attempt?.submitted == true) Text(stringResource(R.string.recovery_submitted))
                if (target.key in input.failed) Text(stringResource(R.string.recovery_failed))
                if (
                    data.classification.canContinue &&
                        entry.pending == null &&
                        attempt?.submitted != true
                )
                    FlowRow {
                        TextButton(
                            onClick = { composer.recover(target, data.selection.failureId) },
                            enabled = !busy && !unknownReset && !unresolvedOther,
                        ) {
                            Text(stringResource(R.string.recovery_continue))
                        }
                        if (data.resetAccount != null && !confirmedReset || unknownReset)
                            TextButton(
                                onClick = {
                                    composer.recover(target, data.selection.failureId, true)
                                },
                                enabled =
                                    !busy &&
                                        !unresolvedOther &&
                                        (!unknownReset ||
                                            attempt.reset.accountId == data.account?.id),
                            ) {
                                Text(
                                    stringResource(
                                        if (unknownReset) R.string.recovery_reset_retry
                                        else R.string.recovery_reset
                                    )
                                )
                            }
                    }
            }
            TextButton(
                onClick = model::refresh,
                enabled = !offline && read.phase != ChatReadPhase.Loading,
            ) {
                Text(stringResource(R.string.retry))
            }
        }
    }
}
