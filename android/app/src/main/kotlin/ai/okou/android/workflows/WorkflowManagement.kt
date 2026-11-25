package ai.okou.android.workflows

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.SettingsTrigger
import ai.okou.android.WorkspaceFilterRow
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.api.generated.WorkflowAutomationVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant11
import ai.okou.android.api.generated.WorkflowAutomationVariant12
import ai.okou.android.api.generated.WorkflowAutomationVariant13
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant3
import ai.okou.android.api.generated.WorkflowAutomationVariant2
import ai.okou.android.api.generated.WorkflowAutomationVariant3
import ai.okou.android.api.generated.WorkflowAutomationVariant4
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.chat.chatTime
import ai.okou.android.preferences.TimezoneSelectionSheet
import ai.okou.android.preferences.timezoneLabel
import ai.okou.android.state.rememberJournalEditor
import ai.okou.android.workspaceSearchFocusOutline
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.DateFormat
import java.text.NumberFormat
import java.util.Date
import java.util.TimeZone

@Composable
internal fun WorkflowRuleRow(
    rule: WorkflowAutomation,
    state: WorkflowState,
    actionsEnabled: Boolean,
    timezone: String,
    onEdit: (WorkflowEdit.Rule, Boolean) -> Unit,
    restoreEditorFocus: Boolean,
    onEditorFocusRestored: () -> Unit,
    onToggle: (WorkflowAutomation) -> Unit,
    onViewConnection: ((String, String?) -> Unit)?,
    restoreConnectionFocus: Boolean,
    onConnectionFocusRestored: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val connectionRequired = rule.needsConnection(state.connections)
    val status =
        stringResource(
            if (rule.enabled) R.string.workflow_enabled else R.string.workflow_rule_paused,
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
    val titleMinWidth = with(LocalDensity.current) { 16.sp.toDp() * 10 }
    val connector = rule.source.connector
    val canOpenConnection = connector != null && onViewConnection != null
    val toggle = state.toggles[rule.id]
    val pendingToggle = toggle?.takeUnless { it.phase == WorkflowTogglePhase.Failed }
    fun viewConnections() {
        if (connector != null) onViewConnection?.invoke(connector, rule.id)
    }
    Column(
        Modifier.fillMaxWidth().padding(vertical = 12.dp).testTag("workflow_rule_${rule.id}"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        FlowRow(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                ruleTitle(rule),
                Modifier.widthIn(min = titleMinWidth).weight(1f).semantics { heading() },
                style = workflowBodyStyle(),
                fontWeight = FontWeight.SemiBold,
            )
            Box(Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
                WorkflowStatus(badge, badgeColor)
            }
        }
        val scheduleZone = ruleScheduleZone(rule)
        val nextRun =
            rule.nextRunAt
                ?.takeIf { rule.enabled }
                ?.let {
                    stringResource(
                        R.string.workflow_next_run,
                        workflowTimestamp(it, scheduleZone ?: timezone),
                    )
                }
        if (scheduleZone != null) {
            val label = timezoneLabel(scheduleZone)
            val schedule =
                if (nextRun == null) stringResource(R.string.workflow_rule_timezone, label)
                else "$nextRun · $label"
            WorkflowSecondary(schedule, small = true)
        } else {
            ruleDescription(rule, connectionRequired)?.let { WorkflowSecondary(it, small = true) }
            if (nextRun != null) WorkflowSecondary(nextRun, small = true)
        }
        val failure = state.issue?.takeIf { it.ruleId == rule.id }?.failure
        when {
            toggle?.phase == WorkflowTogglePhase.Unconfirmed ->
                WorkflowNotice(R.string.workflow_rule_unconfirmed)
            toggle?.phase == WorkflowTogglePhase.Failed || failure == WorkflowWriteFailure.Failed ->
                WorkflowNotice(R.string.workflow_rule_change_failed)
            failure == WorkflowWriteFailure.Network ->
                WorkflowNotice(R.string.workflow_rule_network_failed)
        }
        if (rule.official == null) {
            val toggleFocus = remember { FocusRequester() }
            val recoveryFocus = remember { FocusRequester() }
            var connectionFocused by remember { mutableStateOf(false) }
            val showSeparateConnection = connectionRequired && rule.enabled
            val restoreToggleFocus = !showSeparateConnection && connectionFocused
            val needsRecovery = connectionRequired && !rule.enabled && pendingToggle == null
            val canToggle = rule.enabled || rule.canEnable(state.connections)
            val toggleEnabled =
                actionsEnabled &&
                    (pendingToggle != null ||
                        !state.writing && (if (needsRecovery) canOpenConnection else canToggle))
            val pendingStatus =
                when (pendingToggle?.phase) {
                    WorkflowTogglePhase.Submitting -> R.string.settings_saving
                    WorkflowTogglePhase.Checking -> R.string.workflow_rule_checking
                    WorkflowTogglePhase.Unconfirmed -> R.string.workflow_rule_unconfirmed
                    else -> null
                }
            LaunchedEffect(showSeparateConnection, restoreConnectionFocus, toggleEnabled) {
                if (restoreConnectionFocus && actionsEnabled) {
                    val target =
                        if (showSeparateConnection && canOpenConnection) recoveryFocus
                        else if (toggleEnabled) toggleFocus else return@LaunchedEffect
                    if (target.requestFocus()) onConnectionFocusRestored()
                } else if (restoreToggleFocus && toggleEnabled) toggleFocus.requestFocus()
            }
            FlowRow(
                Modifier.padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (showSeparateConnection)
                    WorkflowAction(
                        stringResource(R.string.workflow_view_connection),
                        ::viewConnections,
                        Modifier.focusRequester(recoveryFocus).onFocusChanged {
                            connectionFocused = it.isFocused
                        },
                        enabled = actionsEnabled && canOpenConnection && !state.writing,
                    )
                WorkflowAction(
                    stringResource(
                        when {
                            pendingToggle?.enabled == true -> R.string.workflow_enable
                            pendingToggle?.enabled == false -> R.string.workflow_pause
                            rule.enabled -> R.string.workflow_pause
                            needsRecovery -> R.string.workflow_view_connection
                            else -> R.string.workflow_enable
                        },
                    ),
                    {
                        if (needsRecovery) viewConnections()
                        else if (!state.writing && pendingToggle == null) onToggle(rule)
                    },
                    enabled = toggleEnabled,
                    pendingStatus = pendingStatus,
                    showPendingProgress = pendingToggle?.phase != WorkflowTogglePhase.Unconfirmed,
                    modifier =
                        Modifier.focusRequester(toggleFocus)
                            .then(
                                if (needsRecovery) Modifier
                                else Modifier.testTag("workflow_toggle_${rule.id}"),
                            ),
                )
                if (editable != null)
                    WorkflowEditorAction(
                        R.string.workflow_edit,
                        enabled = actionsEnabled && !state.writing && pendingToggle == null,
                        restoreFocus = restoreEditorFocus,
                        onFocusRestored = onEditorFocusRestored,
                    ) { focused ->
                        onEdit(editable, focused)
                    }
            }
        }
    }
}

@Composable
internal fun WorkflowEditorAction(
    label: Int,
    enabled: Boolean,
    restoreFocus: Boolean,
    onFocusRestored: () -> Unit,
    onEdit: (Boolean) -> Unit,
) {
    val actionFocus = rememberWorkflowReturnFocus(restoreFocus, enabled, onFocusRestored)
    WorkflowAction(
        stringResource(label),
        { onEdit(actionFocus.keyboardFocused) },
        actionFocus.modifier,
        enabled = enabled,
    )
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
private fun ruleDescription(rule: WorkflowAutomation, connectionRequired: Boolean): String? {
    if (connectionRequired)
        return stringResource(
            if (rule.enabled) R.string.workflow_resume_provider
            else R.string.workflow_connect_provider,
            stringResource(rule.source.label),
        )
    return when (rule) {
        is WorkflowAutomationVariant1 -> null
        is WorkflowAutomationVariant2 -> rule.eventConfig.outputPattern
        is WorkflowAutomationVariant3 ->
            rule.eventConfig.match?.from?.contains?.let {
                stringResource(R.string.workflow_mail_from_contains, it)
            }
        is WorkflowAutomationVariant4 -> rule.eventConfig.labelName
        is WorkflowAutomationVariant11 -> rule.eventConfig.calendarId
        is WorkflowAutomationVariant12 -> rule.eventConfig.calendarId
        is WorkflowAutomationVariant13 -> rule.eventConfig.calendarId
        else -> rule.githubRepositorySummary() ?: stringResource(rule.source.label)
    }
}

private fun ruleScheduleZone(rule: WorkflowAutomation): String? =
    when (val schedule = (rule as? WorkflowAutomationVariant1)?.schedule) {
        is WorkflowAutomationVariant1ScheduleVariant1 -> schedule.timezone
        is WorkflowAutomationVariant1ScheduleVariant3 -> schedule.timezone
        else -> null
    }

@Composable
internal fun workflowTimestamp(time: String, timezone: String): String {
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
    wide: Boolean,
    onCancel: () -> Unit,
    onViewConnection: ((String) -> Unit)?,
    restoreConnectionFocus: Boolean,
    onConnectionFocusRestored: () -> Unit,
) {
    val horizontalPadding = if (wide) 32.dp else 20.dp
    val activeRule = editor as? WorkflowEdit.Rule
    val available = !state.writing && detail.canEdit(editor)
    val connectionRequired = activeRule?.blockingConnection(detail, state.connections)
    val connector = connectionRequired?.connector
    val showConnectionAction = connector != null && state.connections != null
    val connectionFeedback =
        state.connectionReadFeedback().takeIf {
            activeRule?.value?.trigger?.source?.connector != null
        }
    val saveEnabled =
        available &&
            editor.canSave &&
            connectionRequired == null &&
            state.issue?.failure != WorkflowWriteFailure.UncertainCreate
    val saveFocus = remember { FocusRequester() }
    val recoveryFocus = remember { FocusRequester() }
    val cancelFocus = remember { FocusRequester() }
    var connectionFocused by remember { mutableStateOf(false) }
    var saveFocused by remember { mutableStateOf(false) }
    var restoreSaveFocusAfterWrite by remember { mutableStateOf(false) }
    val restoreSaveFocus =
        !showConnectionAction && saveEnabled && (connectionFocused || restoreSaveFocusAfterWrite)
    LaunchedEffect(showConnectionAction, saveEnabled, restoreConnectionFocus) {
        if (restoreConnectionFocus && !state.writing) {
            val target =
                when {
                    showConnectionAction && onViewConnection != null -> recoveryFocus
                    saveEnabled -> saveFocus
                    else -> cancelFocus
                }
            if (target.requestFocus()) onConnectionFocusRestored()
        } else if (restoreSaveFocus) {
            restoreSaveFocusAfterWrite = false
            saveFocus.requestFocus()
        }
    }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(
            Modifier.widthIn(max = 730.dp)
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = horizontalPadding, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            val heading =
                when (editor) {
                    is WorkflowEdit.Instructions -> R.string.workflow_edit_instructions
                    is WorkflowEdit.Rule ->
                        if (editor.id == null) R.string.workflow_add_automation
                        else R.string.workflow_edit_automation
                }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(heading),
                    Modifier.semantics { heading() },
                    style = MaterialTheme.typography.headlineSmall,
                )
                if (activeRule != null)
                    WorkflowSecondary(detail.displayName ?: detail.name, small = true)
            }
            when (editor) {
                is WorkflowEdit.Instructions -> {
                    val value = editor.value
                    WorkflowField(
                        R.string.workflow_name,
                        value.title,
                        available,
                        errorMessage =
                            if (value.title.isBlank())
                                stringResource(R.string.workflow_name_required)
                            else workflowLengthError(value.title, WORKFLOW_DISPLAY_NAME_LIMIT),
                    ) {
                        model.edit(editor.copy(value = editor.value.copy(title = it)))
                    }
                    WorkflowField(
                        R.string.workflow_purpose,
                        value.purpose,
                        available,
                        errorMessage = workflowLengthError(value.purpose, WORKFLOW_PURPOSE_LIMIT),
                    ) {
                        model.edit(editor.copy(value = editor.value.copy(purpose = it)))
                    }
                    WorkflowField(
                        R.string.workflow_instructions_heading,
                        value.instruction,
                        available,
                        singleLine = false,
                        errorMessage =
                            workflowLengthError(value.instruction, WORKFLOW_INSTRUCTION_LIMIT),
                    ) {
                        model.edit(editor.copy(value = editor.value.copy(instruction = it)))
                    }
                }
                is WorkflowEdit.Rule -> WorkflowRuleFields(editor, available, model::edit)
            }
        }
        WorkflowDivider()
        Column(
            Modifier.widthIn(max = 730.dp)
                .fillMaxWidth()
                .padding(horizontal = horizontalPadding, vertical = 8.dp),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when (state.issue?.failure) {
                WorkflowWriteFailure.UncertainCreate ->
                    WorkflowNotice(R.string.workflow_create_uncertain)
                WorkflowWriteFailure.Conflict -> WorkflowNotice(R.string.workflow_write_conflict)
                WorkflowWriteFailure.Network,
                WorkflowWriteFailure.Failed -> WorkflowNotice(R.string.workflow_write_failed)
                null -> Unit
            }
            val readFeedback = state.detailFailure.cachedReadFeedback() ?: connectionFeedback
            if (readFeedback != null) WorkflowNotice(readFeedback)
            if (connectionRequired != null && state.connections != null) {
                WorkflowStatus(
                    stringResource(
                        R.string.workflow_connect_to_save,
                        stringResource(connectionRequired.label),
                    ),
                    MaterialTheme.colorScheme.error,
                )
            }
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                WorkflowAction(
                    stringResource(R.string.workflow_cancel),
                    onCancel,
                    Modifier.focusRequester(cancelFocus),
                    enabled = !state.writing,
                )
                if (showConnectionAction) {
                    WorkflowAction(
                        stringResource(R.string.workflow_view_connection),
                        { onViewConnection?.invoke(connector) },
                        Modifier.focusRequester(recoveryFocus).onFocusChanged {
                            connectionFocused = it.isFocused
                        },
                        enabled = !state.writing && onViewConnection != null,
                    )
                }
                WorkflowAction(
                    stringResource(R.string.workflow_save),
                    onClick = {
                        restoreSaveFocusAfterWrite = saveFocused
                        model.save(editor)
                    },
                    primary = true,
                    enabled = saveEnabled,
                    pendingStatus = R.string.settings_saving.takeIf { state.writing },
                    modifier =
                        Modifier.focusRequester(saveFocus)
                            .onFocusChanged { saveFocused = it.isFocused }
                            .testTag("workflow_save"),
                )
            }
        }
    }
}

internal fun WorkflowReadFailure?.cachedReadFeedback(
    label: Int = R.string.workflow_refresh_failed,
): Int? =
    when (this) {
        WorkflowReadFailure.Unavailable,
        WorkflowReadFailure.Network,
        WorkflowReadFailure.RefreshFailed -> label
        null -> null
    }

internal fun WorkflowState.connectionReadFeedback(): Int? =
    if (connectionsFailure == null) null
    else if (connections == null) R.string.connector_accounts_failed
    else connectionsFailure.cachedReadFeedback()

@Composable
private fun WorkflowRuleFields(
    editor: WorkflowEdit.Rule,
    enabled: Boolean,
    onChange: (WorkflowEdit.Rule) -> Unit,
) {
    val fields = editor.value
    val editFields = { next: RuleFields -> onChange(editor.copy(value = next)) }
    if (editor.id == null) {
        val mode =
            if (fields.trigger == EditableTrigger.Schedule) TriggerMode.Schedule
            else TriggerMode.Event
        val triggerLabel = stringResource(R.string.workflow_trigger)
        WorkspaceFilterRow(
            TriggerMode.entries,
            mode,
            Role.RadioButton,
            label = {
                stringResource(
                    if (it == TriggerMode.Schedule) R.string.workflow_schedule
                    else R.string.workflow_event,
                )
            },
            modifier =
                Modifier.fillMaxWidth().semantics {
                    contentDescription = triggerLabel
                },
            enabled = enabled,
        ) {
            if (it == mode) return@WorkspaceFilterRow
            when (it) {
                TriggerMode.Schedule ->
                    onChange(
                        editor.copy(
                            value = fields.copy(trigger = EditableTrigger.Schedule),
                            lastEventSource = fields.trigger,
                        ),
                    )
                TriggerMode.Event -> editFields(fields.copy(trigger = editor.lastEventSource))
            }
        }
        if (mode == TriggerMode.Event) {
            val sources = listOf(EditableTrigger.Calendar, EditableTrigger.Gmail)
            WorkflowChoice(
                R.string.workflow_event_source,
                sources.map { stringResource(it.eventLabel) },
                sources.indexOf(fields.trigger),
                enabled,
            ) {
                editFields(fields.copy(trigger = sources[it]))
            }
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
                frequency,
                if (fields.weekdays) 0 else 1,
                enabled,
            ) {
                editFields(fields.copy(weekdays = it == 0))
            }
            WorkflowField(R.string.workflow_time, fields.time, enabled) {
                editFields(fields.copy(time = it))
            }
            WorkflowTimezone(fields.timezone, enabled) { editFields(fields.copy(timezone = it)) }
        }
        EditableTrigger.Gmail ->
            WorkflowField(R.string.workflow_match_subject, fields.subject, enabled) {
                editFields(fields.copy(subject = it))
            }
        EditableTrigger.Calendar ->
            WorkflowField(
                R.string.workflow_calendar_id,
                fields.calendarId,
                enabled,
                errorMessage =
                    workflowLengthError(fields.trimmedCalendarId, WORKFLOW_CALENDAR_ID_LIMIT),
            ) {
                editFields(fields.copy(calendarId = it))
            }
    }
    WorkflowSecondary(
        stringResource(
            if (editor.enabled) R.string.workflow_rule_stays_enabled
            else R.string.workflow_rule_stays_paused,
        ),
        small = true,
    )
}

private enum class TriggerMode {
    Schedule,
    Event,
}

private val EditableTrigger.eventLabel: Int
    get() =
        when (this) {
            EditableTrigger.Schedule -> error("Schedule has no event source")
            EditableTrigger.Gmail -> R.string.workflow_source_gmail
            EditableTrigger.Calendar -> R.string.workflow_source_calendar
        }

@Composable
private fun workflowLengthError(value: String, limit: Int): String? {
    if (value.length <= limit) return null
    val formattedLimit =
        NumberFormat.getIntegerInstance(LocalConfiguration.current.locales[0]).format(limit)
    return stringResource(R.string.workflow_field_too_long, formattedLimit)
}

@Composable
private fun WorkflowField(
    label: Int,
    value: String,
    enabled: Boolean,
    singleLine: Boolean = true,
    errorMessage: String? = null,
    onChange: (String) -> Unit,
) {
    val title = stringResource(label)
    val input = rememberJournalEditor(value, target = label)
    val interactions = remember { MutableInteractionSource() }
    val colors = MaterialTheme.colorScheme
    val isError = errorMessage != null
    Column {
        WorkflowFieldLabel(title)
        Spacer(Modifier.height(8.dp))
        BasicTextField(
            value = input.value,
            onValueChange = {
                if (input.edit(it)) onChange(it.text)
            },
            modifier =
                Modifier.fillMaxWidth()
                    .heightIn(min = if (singleLine) 56.dp else 112.dp)
                    .semantics {
                        contentDescription = title
                        if (errorMessage != null) error(errorMessage)
                    },
            readOnly = !enabled,
            singleLine = singleLine,
            maxLines = if (singleLine) 1 else 8,
            textStyle = workflowBodyStyle().copy(color = colors.onBackground),
            cursorBrush = SolidColor(if (isError) colors.error else colors.onBackground),
            interactionSource = interactions,
            decorationBox = { inner ->
                OutlinedTextFieldDefaults.DecorationBox(
                    value = value,
                    innerTextField = inner,
                    enabled = true,
                    singleLine = singleLine,
                    visualTransformation = VisualTransformation.None,
                    interactionSource = interactions,
                    contentPadding = PaddingValues(12.dp),
                    isError = isError,
                    container = {
                        OutlinedTextFieldDefaults.Container(
                            enabled = true,
                            isError = isError,
                            interactionSource = interactions,
                            shape = RoundedCornerShape(12.dp),
                        )
                    },
                )
            },
        )
        if (errorMessage != null) {
            Text(
                errorMessage,
                Modifier.padding(top = 4.dp),
                color = colors.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun WorkflowFieldLabel(title: String) {
    Text(title, style = workflowBodyStyle().copy(fontSize = 14.sp, lineHeight = 20.sp))
}

@Composable
private fun WorkflowChoice(
    label: Int,
    options: List<String>,
    selected: Int,
    enabled: Boolean,
    pick: (Int) -> Unit,
) {
    Column {
        WorkflowFieldLabel(stringResource(label))
        Spacer(Modifier.height(8.dp))
        Box {
            SettingsTrigger(
                enabled = enabled,
                content = { dismiss ->
                    WorkspaceMenu(
                        items =
                            options.mapIndexed { index, option ->
                                WorkspaceMenuItem(option, selected = index == selected) {
                                    dismiss()
                                    if (index != selected) pick(index)
                                }
                            },
                        close = dismiss,
                    )
                },
            ) { trigger, open ->
                WorkflowSelection(options[selected], enabled, trigger, onClick = open)
            }
        }
    }
}

@Composable
private fun WorkflowTimezone(current: String, enabled: Boolean, pick: (String) -> Unit) {
    val title = stringResource(R.string.workflow_timezone)
    Column {
        WorkflowFieldLabel(title)
        Spacer(Modifier.height(8.dp))
        SettingsTrigger(
            enabled = enabled,
            content = { dismiss -> TimezoneSelectionSheet(current, title, dismiss, pick) },
        ) { trigger, open ->
            WorkflowSelection(
                timezoneLabel(current),
                enabled,
                trigger.testTag("workflow_timezone"),
                onClick = open,
            )
        }
    }
}

@Composable
private fun WorkflowSelection(
    value: String,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(12.dp)
    val colors = MaterialTheme.colorScheme
    OutlinedButton(
        onClick,
        modifier.fillMaxWidth().heightIn(min = 56.dp).workspaceSearchFocusOutline(shape),
        enabled = enabled,
        shape = shape,
        border = BorderStroke(1.dp, colors.outline),
        contentPadding = PaddingValues(12.dp),
    ) {
        Text(
            value,
            Modifier.weight(1f),
            color = if (enabled) colors.onBackground else colors.onSurfaceVariant,
            style = workflowBodyStyle(),
        )
        Spacer(Modifier.size(8.dp))
        Icon(
            painterResource(R.drawable.ic_expand_more),
            contentDescription = null,
            modifier = Modifier.size(20.dp),
            tint = colors.onSurfaceVariant,
        )
    }
}
