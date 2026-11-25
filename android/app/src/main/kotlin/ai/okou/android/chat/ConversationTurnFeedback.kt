package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.updates.updateFocusOutline
import android.content.res.Resources
import android.text.format.DateFormat
import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringArrayResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.offset
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone
import kotlinx.coroutines.delay

@Composable
internal fun ConversationReplySummary(
    summary: ReplySummary,
    steps: Int,
    expanded: Boolean,
    onToggle: () -> Unit,
) {
    val locales = LocalConfiguration.current.locales
    val resources = LocalResources.current
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
        remember(roundedDuration, locales, resources) {
            roundedDuration?.let { formatWorkDuration(resources, it) }
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
        val disclosure =
            stringResource(
                if (expanded) R.string.conversation_replies_expanded
                else R.string.conversation_replies_collapsed,
            )
        ConversationTextAction(
            onClick = onToggle,
            modifier = summaryTag.semantics { stateDescription = "$phaseLabel, $disclosure" },
        ) { foreground ->
            ReplySummaryLabel(icon, label, summary.phase, expanded, foreground)
        }
    } else {
        Box(
            summaryTag.heightIn(min = 32.dp).padding(vertical = 4.dp).semantics(
                mergeDescendants = true,
            ) {
                stateDescription = phaseLabel
            },
            contentAlignment = Alignment.CenterStart,
        ) {
            ReplySummaryLabel(
                icon,
                label,
                summary.phase,
                null,
                MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ReplySummaryLabel(
    @DrawableRes icon: Int,
    label: String,
    phase: ReplyPhase,
    expanded: Boolean?,
    foreground: Color,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(icon),
            null,
            Modifier.size(16.dp),
            tint = if (phase == ReplyPhase.Failed) colors.error else foreground,
        )
        Text(
            label,
            Modifier.weight(1f, fill = false),
            color = foreground,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
        )
        if (expanded != null) {
            Icon(
                painterResource(
                    if (expanded) R.drawable.ic_expand_more else R.drawable.ic_chevron_right,
                ),
                null,
                Modifier.size(16.dp),
                tint = foreground,
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
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val lineGap = 8.dp
            val minimumLineWidth = 8.dp
            val labelWidth = (maxWidth - lineGap - minimumLineWidth).coerceAtLeast(0.dp)
            Row(
                horizontalArrangement = Arrangement.spacedBy(lineGap),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    label,
                    Modifier.widthIn(max = labelWidth),
                    color = colors.onSurfaceVariant,
                    style =
                        MaterialTheme.typography.bodyMedium.copy(
                            fontStyle = FontStyle.Italic,
                            fontFeatureSettings = "tnum",
                        ),
                )
                HorizontalDivider(Modifier.weight(1f), color = colors.outlineVariant)
            }
        }
        if (onFollowup != null && completion.followups.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            for (followup in completion.followups) {
                ConversationFollowupRow(followup) { onFollowup(followup.prompt) }
            }
        }
    }
}

@Composable
private fun ConversationFollowupRow(followup: ConversationFollowup, onClick: () -> Unit) {
    val textStyle = MaterialTheme.typography.bodyMedium
    val lineHeight = with(LocalDensity.current) { textStyle.lineHeight.toDp() }
    val icon =
        when (followup.kind) {
            ConversationFollowupKind.Talk -> R.drawable.ic_chat_bubble
            ConversationFollowupKind.Generate -> R.drawable.ic_inventory_2
            ConversationFollowupKind.Workflow -> R.drawable.ic_account_tree
            ConversationFollowupKind.Email -> R.drawable.ic_mail
        }
    ConversationTextAction(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().testTag("conversation_followup"),
    ) { foreground ->
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.height(lineHeight), contentAlignment = Alignment.Center) {
                Icon(
                    painterResource(icon),
                    null,
                    Modifier.size(16.dp),
                    tint = foreground,
                )
            }
            Text(
                followup.prompt,
                color = foreground,
                style = textStyle,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ConversationTextAction(
    onClick: () -> Unit,
    modifier: Modifier,
    content: @Composable (Color) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val interactions = remember { MutableInteractionSource() }
    val hovered by interactions.collectIsHoveredAsState()
    val focused by interactions.collectIsFocusedAsState()
    val keyboardFocused = focused && LocalInputModeManager.current.inputMode == InputMode.Keyboard
    val active = hovered || keyboardFocused
    val foreground = if (active) colors.onSecondaryContainer else colors.onSurfaceVariant
    val shape = RoundedCornerShape(12.dp)
    Box(
        Modifier.layout { measurable, constraints ->
                val outset = 8.dp.roundToPx()
                val action = measurable.measure(constraints.offset(horizontal = outset))
                layout(constraints.constrainWidth(action.width - outset), action.height) {
                    action.placeRelative(-outset, 0)
                }
            }
            .then(modifier)
            .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
            .clip(shape)
            .background(if (active) colors.secondaryContainer else Color.Transparent)
            .updateFocusOutline(shape, colors.onSurface, keyboardOnly = true, outlineInset = 3.dp)
            .clickable(
                interactionSource = interactions,
                indication = ChatPressRipple,
                onClick = onClick,
            )
            .padding(horizontal = 8.dp, vertical = 4.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        content(foreground)
    }
}

internal fun formatWorkDuration(resources: Resources, duration: WorkDuration): String =
    when {
        duration.hours > 0 && duration.minutes > 0 ->
            resources.getString(
                R.string.conversation_work_hours_minutes,
                duration.hours,
                duration.minutes,
            )
        duration.hours > 0 -> resources.getString(R.string.conversation_work_hours, duration.hours)
        duration.minutes > 0 && duration.seconds > 0 ->
            resources.getString(
                R.string.conversation_work_minutes_seconds,
                duration.minutes,
                duration.seconds,
            )
        duration.minutes > 0 ->
            resources.getString(R.string.conversation_work_minutes, duration.minutes)
        else -> resources.getString(R.string.conversation_work_seconds, duration.seconds)
    }
