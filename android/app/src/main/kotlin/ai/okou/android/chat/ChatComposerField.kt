package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.state.rememberJournalEditor
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun ChatComposerField(
    model: ChatComposerModel,
    target: ComposerTarget,
    modifier: Modifier = Modifier,
) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val focus = LocalFocusManager.current
    val entry = state.entry(target)
    val input = rememberJournalEditor(state.journal?.let { entry.text }, target.key)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, target, lifecycle) {
        fun open() {
            model.open(target)
            model.observe(target)
        }
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) open()
        }
        lifecycle.addObserver(observer)
        open()
        onDispose { lifecycle.removeObserver(observer) }
    }
    Column(
        modifier
            .fillMaxWidth()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(12.dp)
            .testTag("chat_composer")
    ) {
        if (state.persistence == ComposerPersistence.Failed) {
            Text(stringResource(R.string.composer_local_failed))
            TextButton(
                onClick = { if (state.journal == null) model.open(target) else model.retryLocal() }
            ) {
                Text(stringResource(R.string.retry))
            }
        }
        if (target.threadId == null && state.context != ComposerContext.Ready) {
            Text(
                stringResource(
                    if (state.context == ComposerContext.Loading) R.string.composer_target_loading
                    else R.string.composer_target_unavailable
                )
            )
            if (state.context != ComposerContext.Loading)
                TextButton(onClick = { model.open(target) }) {
                    Text(stringResource(R.string.retry))
                }
        }
        entry.pending?.let { pending ->
            Text(
                stringResource(R.string.composer_unconfirmed),
                style = MaterialTheme.typography.labelLarge,
            )
            Text(pending.send.prompt, maxLines = 3, overflow = TextOverflow.Ellipsis)
            FlowRow {
                TextButton(
                    onClick = { model.observe(target) },
                    enabled = target.key !in state.busy,
                ) {
                    Text(stringResource(R.string.composer_check))
                }
                TextButton(onClick = { model.retry(target) }, enabled = target.key !in state.busy) {
                    Text(stringResource(R.string.composer_retry))
                }
            }
        }
        entry.receipt?.let {
            Text(
                stringResource(it.disposition.label()),
                modifier = Modifier.testTag("send_receipt"),
            )
        }
        if (target.key in state.unobserved) Text(stringResource(R.string.composer_not_observed))
        if (target.key in state.failed) Text(stringResource(R.string.composer_request_failed))
        OutlinedTextField(
            value = input.value,
            onValueChange = {
                input.edit(it)
                model.edit(target, it.text)
            },
            modifier = Modifier.fillMaxWidth().testTag("message_input"),
            enabled = state.journal != null,
            label = { Text(stringResource(R.string.composer_message)) },
            maxLines = 6,
        )
        FlowRow {
            Button(
                onClick = {
                    focus.clearFocus()
                    model.send(target)
                },
                enabled = state.canSend(target),
            ) {
                Text(stringResource(R.string.composer_send))
            }
            if (entry.receipt != null)
                TextButton(
                    onClick = { model.observe(target) },
                    enabled = target.key !in state.busy,
                ) {
                    Text(stringResource(R.string.composer_check))
                }
        }
        if (state.persistence == ComposerPersistence.Pending)
            Text(
                stringResource(R.string.composer_saving),
                style = MaterialTheme.typography.labelSmall,
            )
    }
}

private fun TextDisposition.label() =
    when (this) {
        TextDisposition.Accepted -> R.string.composer_accepted
        TextDisposition.Queued -> R.string.history_queued
        TextDisposition.Consumed -> R.string.composer_consumed
        TextDisposition.Completed -> R.string.history_completed
        TextDisposition.Failed -> R.string.history_run_failed
        TextDisposition.Cancelled -> R.string.history_cancelled
        TextDisposition.Rejected -> R.string.history_rejected
        TextDisposition.Revoked -> R.string.composer_revoked
    }
