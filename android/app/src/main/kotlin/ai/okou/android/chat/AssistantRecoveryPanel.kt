package ai.okou.android.chat

import ai.okou.android.OkouConfirmationDialog
import ai.okou.android.R
import ai.okou.android.api.generated.ResetSubscriptionResultOutcome
import android.text.format.DateUtils
import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun AssistantRecoveryPanel(
    model: AssistantRecoveryModel,
    composer: ChatComposerModel,
    target: ComposerTarget,
    failureId: String,
    reason: String?,
) {
    val read by model.uiState.collectAsStateWithLifecycle()
    val input by composer.uiState.collectAsStateWithLifecycle()
    if (read.selection?.threadId != target.threadId || read.selection?.failureId != failureId) {
        AssistantFailureCard(reason)
        return
    }
    val entry = input.entry(target)
    val busy = target.key in input.busy || input.persistence != ComposerPersistence.Durable
    val attempt = entry.recovery?.takeIf { it.selection == read.selection }
    val unresolvedOther =
        entry.recovery?.let {
            it.selection != read.selection && it.reset != null && it.outcome == null
        } == true
    val unknownReset = attempt?.reset != null && attempt.outcome == null
    val recoveryProgress = read.selection?.let(input.recovering::get)
    val account = read.data?.resetAccount
    var confirmReset by remember(read.selection, account?.id) { mutableStateOf(false) }
    if (confirmReset && account != null && !unknownReset) {
        OkouConfirmationDialog(
            title = stringResource(R.string.recovery_reset_title),
            confirm = stringResource(R.string.recovery_reset),
            onDismiss = { confirmReset = false },
            onConfirm = {
                confirmReset = false
                composer.confirmRecoveryReset(target, failureId, account.id)
            },
            confirmEnabled = !busy && entry.pending == null,
        ) {
            Text(
                stringResource(
                    R.string.recovery_reset_confirmation,
                    account.accountEmail ?: account.workspaceName ?: account.id,
                ),
            )
        }
    }
    AssistantFailureCard(reason) {
        if (read.phase == ChatReadPhase.Loading)
            RecoveryNote(stringResource(R.string.recovery_loading), announced = true)
        if (read.phase == ChatReadPhase.Failed)
            RecoveryNote(stringResource(R.string.recovery_read_failed), error = true)
        val data = read.data
        if (data != null) {
            val confirmedReset =
                attempt?.reset?.accountId == data.account?.id &&
                    attempt?.reset != null &&
                    attempt.outcome != null &&
                    attempt.outcome != ResetSubscriptionResultOutcome.NOCREDIT
            data.account?.let {
                RecoveryNote(
                    stringResource(
                        R.string.recovery_account,
                        it.accountEmail ?: it.workspaceName ?: it.id,
                    ),
                )
            }
            val context = LocalContext.current
            data.resetTimes.forEach { value ->
                val time =
                    remember(value) {
                        runCatching { chatTime(value) }.getOrNull()
                    }
                if (time != null) {
                    RecoveryNote(
                        stringResource(
                            R.string.recovery_reset_time,
                            DateUtils.formatDateTime(
                                context,
                                time,
                                DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME,
                            ),
                        ),
                    )
                }
            }
            data.account?.subscriptionResetCredits?.let {
                RecoveryNote(stringResource(R.string.recovery_credits, it))
            }
            data.billing?.let {
                RecoveryNote(stringResource(R.string.recovery_billing, it.credits.toString()))
            }
            when {
                recoveryProgress != null ->
                    RecoveryNote(
                        stringResource(
                            if (recoveryProgress == RecoveryOperationPhase.CheckingReset)
                                R.string.recovery_checking_reset
                            else R.string.recovery_working,
                        ),
                        announced = true,
                    )
                unknownReset || unresolvedOther ->
                    RecoveryNote(
                        stringResource(R.string.recovery_reset_unknown),
                        announced = true,
                    )
                attempt?.submitted == true ->
                    RecoveryNote(stringResource(R.string.recovery_submitted), announced = true)
                input.recoveryFailures[target.key] == read.selection ->
                    RecoveryNote(stringResource(R.string.recovery_failed), error = true)
                attempt?.outcome == ResetSubscriptionResultOutcome.NOCREDIT ->
                    RecoveryNote(stringResource(R.string.recovery_no_credit), error = true)
            }
            if (
                data.classification.canContinue &&
                    entry.pending == null &&
                    attempt?.submitted != true
            )
                FlowRow(
                    Modifier.padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(
                        onClick = { composer.recover(target, data.selection.failureId) },
                        modifier = Modifier.heightIn(min = 48.dp),
                        enabled = !busy && !unknownReset && !unresolvedOther,
                        shape = RoundedCornerShape(12.dp),
                        colors =
                            ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.onSurface,
                                contentColor = MaterialTheme.colorScheme.surface,
                            ),
                    ) {
                        Text(stringResource(R.string.recovery_continue))
                    }
                    if (data.resetAccount != null && !confirmedReset || unknownReset) {
                        val resetEnabled =
                            !busy &&
                                !unresolvedOther &&
                                (!unknownReset || attempt.reset.accountId == data.account?.id)
                        OutlinedButton(
                            onClick = {
                                if (unknownReset)
                                    composer.checkRecoveryReset(
                                        target,
                                        failureId,
                                        attempt.reset.idempotencyKey,
                                    )
                                else confirmReset = true
                            },
                            modifier = Modifier.heightIn(min = 48.dp),
                            enabled = resetEnabled,
                            shape = RoundedCornerShape(12.dp),
                            border =
                                if (resetEnabled)
                                    BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
                                else ButtonDefaults.outlinedButtonBorder(enabled = false),
                        ) {
                            Text(
                                stringResource(
                                    if (unknownReset) R.string.recovery_reset_retry
                                    else R.string.recovery_reset,
                                ),
                            )
                        }
                    }
                }
        }
    }
}

@Composable
internal fun AssistantFailureCard(reason: String?, content: @Composable () -> Unit = {}) {
    val copy = assistantRunFailureCopy(reason)
    FailureFeedbackCard(copy.title, copy.description, content)
}

@Composable
internal fun FailureFeedbackCard(
    @StringRes title: Int,
    @StringRes description: Int? = null,
    content: @Composable () -> Unit,
) {
    Surface(
        Modifier.fillMaxWidth().testTag("conversation_failure_card"),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text(
                stringResource(title),
                style =
                    MaterialTheme.typography.bodyLarge.copy(
                        fontSize = 16.sp,
                        lineHeight = 24.sp,
                        fontWeight = FontWeight.Medium,
                    ),
            )
            if (description != null)
                Text(
                    stringResource(description),
                    modifier = Modifier.padding(top = 4.dp),
                    style =
                        MaterialTheme.typography.bodyMedium.copy(
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                        ),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            content()
        }
    }
}

@Composable
private fun RecoveryNote(text: String, error: Boolean = false, announced: Boolean = error) {
    Text(
        text,
        modifier =
            Modifier.padding(top = 4.dp)
                .then(
                    if (announced) Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                    else Modifier,
                ),
        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
        color =
            if (error) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
