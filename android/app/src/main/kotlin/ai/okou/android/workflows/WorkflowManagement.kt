package ai.okou.android.workflows

import ai.okou.android.BuildConfig
import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.api.generated.WorkflowAutomationVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant11
import ai.okou.android.api.generated.WorkflowAutomationVariant12
import ai.okou.android.api.generated.WorkflowAutomationVariant13
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant2
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant3
import ai.okou.android.api.generated.WorkflowAutomationVariant2
import ai.okou.android.api.generated.WorkflowAutomationVariant3
import ai.okou.android.api.generated.WorkflowAutomationVariant4
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.chat.chatTime
import android.icu.text.TimeZoneNames
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.text.DateFormat
import java.util.Date
import java.util.TimeZone
import kotlin.math.abs

@Composable
internal fun WorkflowRuleRow(
    rule: WorkflowAutomation,
    state: WorkflowState,
    canManage: Boolean,
    timezone: String,
    onEdit: (WorkflowEdit.Rule) -> Unit,
    onToggle: (WorkflowAutomation) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val connectionRequired = rule.needsConnection(state.connections)
    val status =
        stringResource(
            if (rule.enabled) R.string.workflow_enabled else R.string.workflow_rule_paused
        )
    val badge =
        if (connectionRequired) stringResource(R.string.workflow_status_connection, status)
        else status
    val badgeColor =
        when {
            connectionRequired -> colors.error
            rule.enabled -> LocalActivityStatusColor.current
            else -> colors.onSurfaceVariant
        }
    val editable = remember(rule, timezone) { rule.editableRule(timezone) }
    val uriHandler = LocalUriHandler.current
    var couldNotOpen by remember(rule.id) { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().padding(vertical = 12.dp).testTag("workflow_rule_${rule.id}"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                ruleTitle(rule),
                Modifier.weight(1f).semantics { heading() },
                style = workflowBodyStyle(),
                fontWeight = FontWeight.SemiBold,
            )
            Box(Modifier.widthIn(max = 130.dp).semantics { liveRegion = LiveRegionMode.Polite }) {
                WorkflowStatus(badge, badgeColor)
            }
        }
        val description = ruleDescription(rule, timezone, connectionRequired)
        if (description != null) WorkflowSecondary(description, small = true)
        if (rule.enabled && rule.nextRunAt != null) {
            WorkflowSecondary(
                stringResource(
                    R.string.workflow_next_run,
                    workflowTimestamp(rule.nextRunAt.orEmpty(), ruleZone(rule, timezone)),
                ),
                small = true,
            )
        }
        if (canManage && rule.official == null) {
            FlowRow(
                Modifier.padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (connectionRequired)
                    WorkflowAction(
                        stringResource(R.string.workflow_view_connection),
                        {
                            couldNotOpen =
                                try {
                                    uriHandler.openUri("${BuildConfig.WEB_ORIGIN}/connectors")
                                    false
                                } catch (_: IllegalArgumentException) {
                                    true
                                }
                        },
                    )
                if (rule.enabled || !connectionRequired)
                    WorkflowAction(
                        stringResource(
                            if (rule.enabled) R.string.workflow_pause else R.string.workflow_enable
                        ),
                        { if (!state.writing) onToggle(rule) },
                        enabled = !state.offline,
                        modifier = Modifier.testTag("workflow_toggle_${rule.id}"),
                    )
                if (editable != null)
                    WorkflowAction(
                        stringResource(R.string.workflow_edit),
                        { onEdit(editable) },
                        enabled = !state.offline && !state.writing,
                    )
            }
        }
        if (couldNotOpen) WorkflowNotice(R.string.workflow_connection_unavailable)
    }
}

@Composable
private fun ruleTitle(rule: WorkflowAutomation): String =
    when (rule) {
        is WorkflowAutomationVariant1 -> {
            val simple =
                (rule.schedule as? WorkflowAutomationVariant1ScheduleVariant1)?.simpleRule()
            if (simple == null) rule.scheduleSummary
            else
                stringResource(
                    if (simple.weekdays) R.string.workflow_weekday_schedule
                    else R.string.workflow_daily_schedule,
                    simple.time,
                )
        }
        is WorkflowAutomationVariant3 ->
            rule.eventConfig.match?.subject?.contains?.let {
                stringResource(R.string.workflow_mail_subject_contains, it)
            } ?: stringResource(rule.eventLabel)
        else -> stringResource(rule.eventLabel)
    }

@Composable
private fun ruleDescription(
    rule: WorkflowAutomation,
    timezone: String,
    connectionRequired: Boolean,
): String? {
    if (connectionRequired)
        return stringResource(R.string.workflow_connect_provider, stringResource(rule.source.label))
    return when (rule) {
        is WorkflowAutomationVariant1 ->
            when (val schedule = rule.schedule) {
                is WorkflowAutomationVariant1ScheduleVariant1,
                is WorkflowAutomationVariant1ScheduleVariant3 ->
                    stringResource(R.string.workflow_rule_timezone, ruleZone(rule, timezone))
                is WorkflowAutomationVariant1ScheduleVariant2 -> null
            }
        is WorkflowAutomationVariant2 -> rule.eventConfig.outputPattern
        is WorkflowAutomationVariant3 ->
            rule.eventConfig.match?.from?.contains?.let {
                stringResource(R.string.workflow_mail_from_contains, it)
            }
        is WorkflowAutomationVariant4 -> rule.eventConfig.labelName
        is WorkflowAutomationVariant11 -> rule.eventConfig.calendarId
        is WorkflowAutomationVariant12 -> rule.eventConfig.calendarId
        is WorkflowAutomationVariant13 -> rule.eventConfig.calendarId
        else -> stringResource(rule.source.label)
    }
}

private fun ruleZone(rule: WorkflowAutomation, fallback: String): String =
    when (val schedule = (rule as? WorkflowAutomationVariant1)?.schedule) {
        is WorkflowAutomationVariant1ScheduleVariant1 -> schedule.timezone
        is WorkflowAutomationVariant1ScheduleVariant3 -> schedule.timezone
        else -> fallback
    }

@Composable
internal fun WorkflowHistoryRow(
    rule: WorkflowAutomation,
    timezone: String,
    sourceChatAvailable: (String) -> Boolean,
    onOpenChat: (String) -> Unit,
) {
    val source = rule.chatThreadId?.takeIf(sourceChatAvailable)
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 52.dp)
            .clip(RoundedCornerShape(8.dp))
            .then(
                if (source != null) Modifier.clickable(role = Role.Button) { onOpenChat(source) }
                else Modifier
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(R.drawable.ic_event), null, Modifier.size(18.dp))
        Column(Modifier.weight(1f)) {
            Text(
                workflowTimestamp(rule.lastRunAt.orEmpty(), timezone),
                style = workflowBodyStyle(),
                fontWeight = FontWeight.SemiBold,
            )
            WorkflowSecondary(ruleTitle(rule), small = true)
        }
        if (source != null)
            Icon(painterResource(R.drawable.ic_chevron_right), null, Modifier.size(18.dp))
    }
}

@Composable
private fun workflowTimestamp(time: String, timezone: String): String {
    val locale = LocalConfiguration.current.locales[0]
    return remember(time, timezone, locale) {
        try {
            DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, locale)
                .apply { timeZone = TimeZone.getTimeZone(timezone) }
                .format(Date(chatTime(time)))
        } catch (_: ApiFailure.IncompatibleResponse) {
            time
        }
    }
}

@Composable
internal fun WorkflowEditor(
    detail: WorkflowDetail,
    editor: WorkflowEdit,
    state: WorkflowState,
    model: WorkflowModel,
    onCancel: () -> Unit,
) {
    val available = !state.writing && detail.canManage
    val canSave =
        when (editor) {
            is WorkflowEdit.Instructions -> editor.changed && editor.value.valid
            is WorkflowEdit.Rule -> (editor.id == null || editor.changed) && editor.value.valid
        }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(
            Modifier.widthIn(max = 730.dp)
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            val heading =
                when (editor) {
                    is WorkflowEdit.Instructions -> R.string.workflow_edit_instructions
                    is WorkflowEdit.Rule ->
                        if (editor.id == null) R.string.workflow_add_automation
                        else R.string.workflow_edit_automation
                }
            Text(
                stringResource(heading),
                Modifier.semantics { heading() },
                style = MaterialTheme.typography.headlineSmall,
            )
            when (editor) {
                is WorkflowEdit.Instructions -> {
                    WorkflowField(R.string.workflow_name, editor.value.title, available) {
                        model.edit(editor.copy(value = editor.value.copy(title = it)))
                    }
                    WorkflowField(R.string.workflow_purpose, editor.value.purpose, available) {
                        model.edit(editor.copy(value = editor.value.copy(purpose = it)))
                    }
                    WorkflowField(
                        R.string.workflow_instructions_heading,
                        editor.value.instruction,
                        available,
                        singleLine = false,
                    ) {
                        model.edit(editor.copy(value = editor.value.copy(instruction = it)))
                    }
                }
                is WorkflowEdit.Rule ->
                    WorkflowRuleFields(editor, available) { model.edit(editor.copy(value = it)) }
            }
        }
        WorkflowDivider()
        Column(
            Modifier.widthIn(max = 730.dp)
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.End,
        ) {
            when {
                state.offline -> WorkflowNotice(R.string.workflow_offline_changes)
                state.issue == WorkflowWriteIssue.UncertainCreate ->
                    WorkflowNotice(R.string.workflow_create_uncertain)
                state.issue != null -> WorkflowNotice(R.string.workflow_write_failed)
            }
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                WorkflowAction(
                    stringResource(R.string.workflow_cancel),
                    onCancel,
                    enabled = !state.writing,
                )
                WorkflowAction(
                    stringResource(R.string.workflow_save),
                    onClick = {
                        when (editor) {
                            is WorkflowEdit.Instructions ->
                                model.updateInstructions(editor.value.changesFrom(editor.original))
                            is WorkflowEdit.Rule ->
                                if (editor.id == null)
                                    model.saveRule(null, editor.value.createRequest(), null)
                                else model.saveRule(editor.id, null, editor.value.updateRequest())
                        }
                    },
                    primary = true,
                    enabled =
                        available &&
                            canSave &&
                            !state.offline &&
                            state.issue != WorkflowWriteIssue.UncertainCreate,
                    modifier = Modifier.testTag("workflow_save"),
                )
            }
        }
    }
}

@Composable
private fun WorkflowRuleFields(
    editor: WorkflowEdit.Rule,
    enabled: Boolean,
    onChange: (RuleFields) -> Unit,
) {
    val fields = editor.value
    if (editor.id == null) {
        val triggers = EditableTrigger.entries
        WorkflowChoice(
            R.string.workflow_trigger,
            stringResource(fields.trigger.label),
            triggers.map { stringResource(it.label) },
            enabled,
        ) {
            onChange(fields.copy(trigger = triggers[it]))
        }
    }
    when (fields.trigger) {
        EditableTrigger.Schedule -> {
            val frequency =
                listOf(
                    stringResource(R.string.workflow_weekdays),
                    stringResource(R.string.workflow_daily),
                )
            WorkflowChoice(
                R.string.workflow_frequency,
                frequency[if (fields.weekdays) 0 else 1],
                frequency,
                enabled,
            ) {
                onChange(fields.copy(weekdays = it == 0))
            }
            WorkflowField(R.string.workflow_time, fields.time, enabled) {
                onChange(fields.copy(time = it))
            }
            WorkflowTimezone(fields.timezone, enabled) { onChange(fields.copy(timezone = it)) }
        }
        EditableTrigger.Gmail ->
            WorkflowField(R.string.workflow_match_subject, fields.subject, enabled) {
                onChange(fields.copy(subject = it))
            }
        EditableTrigger.Calendar ->
            WorkflowField(R.string.workflow_calendar_id, fields.calendarId, enabled) {
                onChange(fields.copy(calendarId = it))
            }
    }
    WorkflowSecondary(
        stringResource(
            if (editor.enabled) R.string.workflow_rule_stays_enabled
            else R.string.workflow_rule_stays_paused
        ),
        small = true,
    )
}

private val EditableTrigger.label: Int
    get() =
        when (this) {
            EditableTrigger.Schedule -> R.string.workflow_schedule
            EditableTrigger.Gmail -> R.string.workflow_mail_received
            EditableTrigger.Calendar -> R.string.workflow_event_created
        }

@Composable
private fun WorkflowField(
    label: Int,
    value: String,
    enabled: Boolean,
    singleLine: Boolean = true,
    onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        modifier = Modifier.fillMaxWidth(),
        enabled = enabled,
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 4,
        textStyle = workflowBodyStyle(),
        shape = RoundedCornerShape(12.dp),
        label = { Text(stringResource(label)) },
    )
}

@Composable
private fun WorkflowChoice(
    label: Int,
    current: String,
    options: List<String>,
    enabled: Boolean,
    pick: (Int) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Column {
        Text(stringResource(label), style = workflowSmallStyle())
        Spacer(Modifier.height(8.dp))
        Box {
            WorkflowAction(current, { expanded = true }, Modifier.fillMaxWidth(), enabled)
            DropdownMenu(expanded, onDismissRequest = { expanded = false }) {
                options.forEachIndexed { index, option ->
                    DropdownMenuItem(
                        text = { Text(option) },
                        onClick = {
                            expanded = false
                            pick(index)
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun WorkflowTimezone(current: String, enabled: Boolean, pick: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val title = stringResource(R.string.workflow_timezone)
    Column {
        Text(title, style = workflowSmallStyle())
        Spacer(Modifier.height(8.dp))
        WorkflowAction(
            timezoneLabel(current),
            { expanded = true },
            Modifier.fillMaxWidth(),
            enabled,
        )
    }
    if (expanded) {
        val zones =
            remember(current) {
                (listOf(
                        current,
                        "Asia/Shanghai",
                        "Asia/Tokyo",
                        "Asia/Singapore",
                        "Europe/London",
                        "America/Los_Angeles",
                        "UTC",
                    ) + TimeZone.getAvailableIDs().sorted())
                    .distinct()
            }
        AlertDialog(
            onDismissRequest = { expanded = false },
            title = { Text(title) },
            text = {
                LazyColumn(Modifier.heightIn(max = 320.dp)) {
                    items(zones, key = { it }) { zone ->
                        TextButton(
                            onClick = {
                                pick(zone)
                                expanded = false
                            },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) {
                            Text(timezoneLabel(zone))
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { expanded = false }) {
                    Text(stringResource(R.string.workflow_cancel))
                }
            },
        )
    }
}

@Composable
private fun timezoneLabel(id: String): String {
    val locale = LocalConfiguration.current.locales[0]
    val utc = stringResource(R.string.workflow_utc)
    return remember(id, locale, utc) {
        val zone = TimeZone.getTimeZone(id)
        if (zone.id == "GMT" && id != "GMT") return@remember id
        val name =
            if (id in setOf("UTC", "Etc/UTC", "GMT")) utc
            else TimeZoneNames.getInstance(locale).getExemplarLocationName(id) ?: id
        val minutes = zone.getOffset(System.currentTimeMillis()) / 60_000
        val sign = if (minutes < 0) "-" else "+"
        val hours = abs(minutes) / 60
        val remainder = abs(minutes) % 60
        val offset =
            if (remainder == 0) "$sign$hours"
            else "$sign$hours:${remainder.toString().padStart(2, '0')}"
        "$name (UTC$offset)"
    }
}
