package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.updates.updateFocusOutline
import android.icu.text.MeasureFormat
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import android.text.format.DateFormat
import androidx.annotation.DrawableRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringArrayResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.delay

@Composable
internal fun ConversationReplySummary(
    summary: ReplySummary,
    steps: Int,
    expanded: Boolean,
    onToggle: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val locale = LocalConfiguration.current.locales[0]
    val elapsed =
        if (summary.phase == ReplyPhase.Replying && summary.startedAtMillis != null) {
            val lifecycle = LocalLifecycleOwner.current.lifecycle
            val now by
                produceState(System.currentTimeMillis(), summary, lifecycle) {
                    lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                        while (true) {
                            value = System.currentTimeMillis()
                            delay(1_000L)
                        }
                    }
                }
            summary.elapsedMillis(now)
        } else summary.elapsedMillis(0L)
    val roundedDuration = elapsed?.let(::workDuration)
    val duration =
        remember(roundedDuration, locale) {
            roundedDuration?.let { formatWorkDuration(it, locale) }
        }
    val elapsedLabel = duration?.let {
        stringResource(
            if (summary.phase == ReplyPhase.Replying) R.string.conversation_work_elapsed
            else R.string.conversation_work_total,
            it,
        )
    }
    val stepLabel = pluralStringResource(R.plurals.conversation_reply_steps, steps, steps)
    val label =
        when {
            elapsedLabel == null -> stepLabel
            steps == 0 -> elapsedLabel
            else -> stringResource(R.string.conversation_feedback_pair, elapsedLabel, stepLabel)
        }
    val (icon, phaseLabelId) =
        when (summary.phase) {
            ReplyPhase.Unknown -> R.drawable.ic_chat_bubble to R.string.conversation_reply_summary
            ReplyPhase.Continued -> R.drawable.ic_schedule to R.string.conversation_turn_continued
            ReplyPhase.Replying -> R.drawable.ic_manufacturing to R.string.conversation_replying
            ReplyPhase.Completed -> R.drawable.ic_check_circle to R.string.conversation_turn_done
            ReplyPhase.Failed -> R.drawable.ic_error_circle to R.string.history_run_failed
            ReplyPhase.Stopped -> R.drawable.ic_stop to R.string.history_cancelled
        }
    val phaseLabel = stringResource(phaseLabelId)
    val summaryTag = Modifier.testTag("conversation_reply_summary")
    if (steps > 0) {
        val shape = RoundedCornerShape(12.dp)
        val disclosure =
            stringResource(
                if (expanded) R.string.conversation_replies_expanded
                else R.string.conversation_replies_collapsed,
            )
        Surface(
            onClick = onToggle,
            modifier =
                summaryTag
                    .heightIn(min = 48.dp)
                    .updateFocusOutline(shape, colors.onSurface)
                    .semantics { stateDescription = "$phaseLabel, $disclosure" },
            shape = shape,
            color = colors.surface,
        ) {
            ReplySummaryLabel(icon, label, summary.phase, expanded)
        }
    } else {
        Box(
            summaryTag.heightIn(min = 32.dp).semantics(mergeDescendants = true) {
                stateDescription = phaseLabel
            },
            contentAlignment = Alignment.CenterStart,
        ) {
            ReplySummaryLabel(icon, label, summary.phase, null)
        }
    }
}

@Composable
private fun ReplySummaryLabel(
    @DrawableRes icon: Int,
    label: String,
    phase: ReplyPhase,
    expanded: Boolean?,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier.padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(icon),
            null,
            Modifier.size(16.dp),
            tint = if (phase == ReplyPhase.Failed) colors.error else colors.onSurfaceVariant,
        )
        Text(
            label,
            Modifier.weight(1f, fill = false),
            color = colors.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
        )
        if (expanded != null) {
            Icon(
                painterResource(
                    if (expanded) R.drawable.ic_expand_more else R.drawable.ic_chevron_right,
                ),
                null,
                Modifier.size(16.dp),
                tint = colors.onSurfaceVariant,
            )
        }
    }
}

@Composable
internal fun ConversationReplyTimeline(content: @Composable ColumnScope.() -> Unit) {
    val line = MaterialTheme.colorScheme.outlineVariant
    Column(
        Modifier.fillMaxWidth()
            .padding(top = 4.dp, bottom = 16.dp)
            .drawBehind {
                val inset = 8.dp.toPx()
                val x = if (layoutDirection == LayoutDirection.Ltr) inset else size.width - inset
                drawLine(line, Offset(x, 0f), Offset(x, size.height), 1.dp.toPx())
            }
            .padding(start = 20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        content = content,
    )
}

@Composable
internal fun ConversationCompletionRow(
    completion: ConversationCompletion,
    modifier: Modifier = Modifier,
    onFollowup: ((String) -> Unit)?,
) {
    val colors = MaterialTheme.colorScheme
    val locale = LocalConfiguration.current.locales[0]
    val twentyFourHours = DateFormat.is24HourFormat(LocalContext.current)
    val timezone = TimeZone.getDefault().id
    val time =
        remember(completion.finishedAtMillis, locale, twentyFourHours, timezone) {
            completion.finishedAtMillis?.let {
                val skeleton = if (twentyFourHours) "MMMdHm" else "MMMdhm"
                SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, skeleton), locale)
                    .apply { timeZone = TimeZone.getTimeZone(timezone) }
                    .format(Date(it))
            }
        }
    val phrases = stringArrayResource(R.array.conversation_completion_phrases)
    val label =
        if (completion.followups.isNotEmpty()) {
            val next = stringResource(R.string.conversation_followup_continue)
            if (time == null) next
            else stringResource(R.string.conversation_feedback_pair, next, time)
        } else {
            val phrase = phrases[(completion.eventId.lastOrNull()?.code ?: 0) % phrases.size]
            if (time == null) phrase
            else stringResource(R.string.conversation_feedback_pair, time, phrase)
        }
    Column(modifier.fillMaxWidth().testTag(ConversationCompletionKey)) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label,
                color = colors.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall.copy(fontStyle = FontStyle.Italic),
            )
            HorizontalDivider(Modifier.weight(1f), color = colors.outlineVariant)
        }
        if (onFollowup != null) {
            for (followup in completion.followups) {
                ConversationFollowupRow(followup) { onFollowup(followup.prompt) }
            }
        }
    }
}

@Composable
private fun ConversationFollowupRow(followup: ConversationFollowup, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    val icon =
        when (followup.kind) {
            ConversationFollowupKind.Talk -> R.drawable.ic_chat_bubble
            ConversationFollowupKind.Generate -> R.drawable.ic_inventory_2
            ConversationFollowupKind.Workflow -> R.drawable.ic_account_tree
            ConversationFollowupKind.Email -> R.drawable.ic_mail
        }
    Surface(
        onClick = onClick,
        modifier =
            Modifier.fillMaxWidth()
                .heightIn(min = 48.dp)
                .updateFocusOutline(shape, colors.onSurface)
                .testTag("conversation_followup"),
        color = colors.surface,
        shape = shape,
    ) {
        Row(
            Modifier.padding(vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(painterResource(icon), null, Modifier.size(16.dp), tint = colors.onSurfaceVariant)
            Text(
                followup.prompt,
                color = colors.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

private fun formatWorkDuration(duration: WorkDuration, locale: Locale): String {
    val measures = buildList {
        if (duration.hours > 0) add(Measure(duration.hours, MeasureUnit.HOUR))
        if (duration.minutes > 0) add(Measure(duration.minutes, MeasureUnit.MINUTE))
        if (duration.seconds > 0 || isEmpty()) add(Measure(duration.seconds, MeasureUnit.SECOND))
    }
    return MeasureFormat.getInstance(locale, MeasureFormat.FormatWidth.WIDE)
        .formatMeasures(*measures.toTypedArray())
}
