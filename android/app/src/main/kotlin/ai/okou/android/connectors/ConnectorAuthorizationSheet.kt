package ai.okou.android.connectors

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItem
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItemGrantKind
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItemManualFieldsItemInputType
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import okhttp3.HttpUrl

@Composable
internal fun ConnectorRenameSheet(
    account: ConnectorSavedAccount,
    canModify: Boolean,
    offline: Boolean,
    action: ConnectorAction?,
    save: (String) -> Unit,
    cancel: () -> Unit,
) {
    val currentLabel = account.label()
    val baseline = remember(account.id) { currentLabel }
    var label by remember(account.id) { mutableStateOf(baseline) }
    var showError by remember(account.id) { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val name = label.trim()
    val errorMessage =
        when {
            name.isEmpty() -> stringResource(R.string.connector_rename_required)
            name.length > CONNECTOR_ACCOUNT_NAME_LIMIT ->
                stringResource(R.string.connector_rename_too_long, CONNECTOR_ACCOUNT_NAME_LIMIT)
            else -> null
        }
    ConnectorSheetHeading(stringResource(R.string.connector_rename_title))
    ConnectorInput(
        stringResource(R.string.connector_account_name),
        label,
        {
            label = it
            if (it.trim().length in 1..CONNECTOR_ACCOUNT_NAME_LIMIT) showError = false
        },
        canModify,
        supportingText =
            stringResource(R.string.connector_rename_hint, CONNECTOR_ACCOUNT_NAME_LIMIT),
        errorMessage = errorMessage.takeIf { showError },
        modifier = Modifier.focusRequester(focus),
    )
    ConnectorActionFeedback(action)
    if (offline) {
        Text(
            stringResource(R.string.connector_offline_action),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = connectorSmallType(),
        )
    }
    ConnectorFormActions(
        stringResource(R.string.instructions_save),
        enabled = canModify && name != baseline.trim(),
        cancel = cancel,
        cancelEnabled = action?.busy != true,
    ) {
        if (errorMessage == null) {
            save(name)
        } else {
            showError = true
            focus.requestFocus()
        }
    }
}

@Composable
internal fun ConnectorAuthorizationSheet(
    model: ConnectorModel,
    detail: ConnectorServiceDetail,
    account: ConnectorSavedAccount?,
    canModify: Boolean,
    action: ConnectorAction?,
    offline: Boolean,
    cancel: () -> Unit,
) {
    val verb =
        stringResource(
            when {
                account?.status == ConnectorAccountStatus.UpdatePermissions ->
                    R.string.connector_update_permissions
                account != null -> R.string.connector_reauthorize
                else -> R.string.connector_connect
            }
        )
    ConnectorSheetHeading(stringResource(R.string.connector_authorization, verb, detail.entry.name))
    if (account?.identity != null) Text(account.identity, style = connectorSmallType())
    if (offline) ConnectorStatusBanner(R.string.connector_offline_action)
    val methods = detail.methods.filter { account == null || it.id == account.authMethod }
    val context = LocalContext.current
    val continueInBrowser = { model.openBrowser { launchConnectorBrowser(context, it) } }
    val canDismiss = action?.busy != true
    val canContinue = canDismiss && action?.reconciling != true && !offline
    when (val step = action?.authorization) {
        is ConnectorAuthorization.Browser -> {
            LaunchedEffect(step, canContinue, action.browserOpened, action.problem) {
                if (canContinue && !action.browserOpened && action.problem == null)
                    continueInBrowser()
            }
            Text(stringResource(R.string.connector_return_browser), style = connectorBodyType())
            ConnectorActionFeedback(action)
            ConnectorFormActions(
                stringResource(R.string.connector_open_provider),
                enabled = canContinue,
                cancel = cancel,
                cancelEnabled = canDismiss,
                submit = continueInBrowser,
            )
            if (action.browserOpened)
                ConnectorButton(
                    stringResource(R.string.connector_verify_authorization),
                    model::checkAuthorization,
                    treatment = ConnectorButtonTreatment.Text,
                    enabled = canContinue,
                )
        }
        is ConnectorAuthorization.Device -> {
            Text(stringResource(R.string.connector_device_code), style = connectorBodyType())
            SelectionContainer { Text(step.code, style = MaterialTheme.typography.titleLarge) }
            ConnectorActionFeedback(action)
            ConnectorFormActions(
                stringResource(R.string.connector_open_provider),
                enabled = canContinue,
                cancel = cancel,
                cancelEnabled = canDismiss,
                submit = continueInBrowser,
            )
        }
        is ConnectorAuthorization.External -> {
            var code by remember(step.sessionId) { mutableStateOf("") }
            Text(
                stringResource(R.string.connector_external_instructions),
                style = connectorBodyType(),
            )
            ConnectorButton(
                stringResource(R.string.connector_open_provider),
                continueInBrowser,
                treatment = ConnectorButtonTreatment.Outline,
                enabled = canContinue,
            )
            ConnectorInput(
                stringResource(R.string.connector_external_code),
                code,
                { code = it },
                canContinue,
                secret = true,
            )
            ConnectorActionFeedback(action)
            ConnectorFormActions(
                stringResource(R.string.connector_submit_code),
                enabled = canContinue && code.isNotBlank() && code.trim().length <= 4096,
                cancel = cancel,
                cancelEnabled = canDismiss,
            ) {
                model.completeExternal(code)
            }
        }
        is ConnectorAuthorization.Receipt -> {
            ConnectorActionFeedback(action)
            ConnectorFormActions(
                stringResource(R.string.connector_verify_authorization),
                enabled = canDismiss && !offline,
                cancel = cancel,
                cancelEnabled = canDismiss,
                submit = model::checkAuthorization,
            )
        }
        null -> {
            if (methods.isEmpty()) {
                ConnectorStatusBanner(R.string.connector_unavailable)
                ConnectorButton(
                    stringResource(R.string.updates_close),
                    cancel,
                    treatment = ConnectorButtonTreatment.Text,
                )
            } else {
                ConnectorMethodForm(
                    methods,
                    detail.googleSecurityWarning,
                    canModify,
                    action,
                    verb,
                    cancel,
                ) { method, values ->
                    model.startAuthorization(account?.id, method, values)
                }
            }
        }
    }
}

@Composable
private fun ConnectorMethodForm(
    methods: List<ConnectorDetailConnectorAuthMethodsItem>,
    googleSecurityWarning: Boolean,
    enabled: Boolean,
    action: ConnectorAction?,
    verb: String,
    cancel: () -> Unit,
    start: (String, Map<String, String>) -> Unit,
) {
    var selectedId by remember(methods) { mutableStateOf(methods.first().id) }
    val method = methods.first { it.id == selectedId }
    val values =
        remember(method.id) {
            mutableStateMapOf<String, String>().apply {
                method.startOptions.forEach { option ->
                    option.defaultValue?.let { put(option.id, it) }
                }
            }
        }
    if (methods.size > 1) {
        Column(Modifier.fillMaxWidth().selectableGroup()) {
            for (item in methods) {
                ConnectorChoice(item.label, item.id == selectedId, enabled) { selectedId = item.id }
            }
        }
    }
    if (!method.description.isNullOrBlank())
        Text(method.description, style = connectorFeedbackType())
    when (method.grantKind) {
        ConnectorDetailConnectorAuthMethodsItemGrantKind.MANUAL -> {
            for (field in method.manualFields) {
                ConnectorInput(
                    field.label,
                    values[field.id].orEmpty(),
                    { values[field.id] = it },
                    enabled = enabled,
                    secret =
                        field.inputType ==
                            ConnectorDetailConnectorAuthMethodsItemManualFieldsItemInputType
                                .PASSWORD,
                    placeholder = field.placeholder,
                )
            }
        }
        ConnectorDetailConnectorAuthMethodsItemGrantKind.NONE ->
            Text(stringResource(R.string.connector_authorize_no_auth), style = connectorBodyType())
        else -> {
            Text(stringResource(R.string.connector_authorize_browser), style = connectorBodyType())
            if (googleSecurityWarning) {
                Text(
                    stringResource(R.string.connector_google_warning),
                    style = connectorFeedbackType(),
                )
            }
            for (option in method.startOptions) {
                Column(Modifier.fillMaxWidth().selectableGroup()) {
                    Text(option.label, style = connectorFeedbackType())
                    for (choice in option.options) {
                        ConnectorChoice(choice.label, values[option.id] == choice.value, enabled) {
                            values[option.id] = choice.value
                        }
                    }
                }
            }
        }
    }
    val ready =
        method.manualFields.all { !it.required || !values[it.id].isNullOrBlank() } &&
            method.startOptions.all { !it.required || !values[it.id].isNullOrBlank() }
    val submitLabel =
        when (method.grantKind) {
            ConnectorDetailConnectorAuthMethodsItemGrantKind.NONE,
            ConnectorDetailConnectorAuthMethodsItemGrantKind.MANUAL -> verb
            else -> stringResource(R.string.connector_continue_provider)
        }
    ConnectorActionFeedback(action)
    ConnectorFormActions(
        submitLabel,
        enabled = enabled && ready,
        cancel = cancel,
        cancelEnabled = action?.busy != true,
    ) {
        start(method.id, values.filterValues { it.isNotBlank() })
    }
}

@Composable
private fun ConnectorChoice(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    choose: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 48.dp)
            .selectable(selected, enabled = enabled, role = Role.RadioButton, onClick = choose)
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(
            selected,
            onClick = null,
            enabled = enabled,
            colors = RadioButtonDefaults.colors(selectedColor = LocalActivityStatusColor.current),
        )
        Text(label, style = connectorBodyType())
    }
}

@Composable
private fun ConnectorInput(
    label: String,
    value: String,
    edit: (String) -> Unit,
    enabled: Boolean,
    secret: Boolean = false,
    placeholder: String? = null,
    supportingText: String? = null,
    errorMessage: String? = null,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, style = connectorFeedbackType())
        OutlinedTextField(
            value = value,
            onValueChange = edit,
            modifier =
                modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("connector-input").semantics {
                    contentDescription = label
                    if (errorMessage != null) error(errorMessage)
                },
            enabled = enabled,
            isError = errorMessage != null,
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            textStyle = connectorBodyType(),
            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = colors.onSurface),
            placeholder = placeholder?.let { { Text(it, style = connectorBodyType()) } },
            supportingText =
                supportingText?.let { hint ->
                    {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(hint, color = colors.onSurfaceVariant)
                            if (errorMessage != null) Text(errorMessage, color = colors.error)
                        }
                    }
                },
            keyboardOptions =
                KeyboardOptions(
                    keyboardType = if (secret) KeyboardType.Password else KeyboardType.Text
                ),
            visualTransformation =
                if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        )
    }
}

@Composable
private fun ConnectorFormActions(
    label: String,
    enabled: Boolean,
    cancel: () -> Unit,
    cancelEnabled: Boolean,
    submit: () -> Unit,
) {
    FlowRow(
        Modifier.fillMaxWidth().padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ConnectorButton(
            stringResource(R.string.settings_cancel),
            cancel,
            enabled = cancelEnabled,
            treatment = ConnectorButtonTreatment.Text,
        )
        ConnectorButton(label, submit, enabled = enabled)
    }
}

private fun launchConnectorBrowser(context: Context, url: HttpUrl): Boolean =
    try {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, url.toString().toUri())
                .addCategory(Intent.CATEGORY_BROWSABLE)
        )
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }
