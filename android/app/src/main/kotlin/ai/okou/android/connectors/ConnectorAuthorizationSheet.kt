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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.TextObfuscationMode
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedSecureTextField
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import okhttp3.HttpUrl

@Composable
internal fun ConnectorRenameSheet(
    account: ConnectorSavedAccount,
    canModify: Boolean,
    action: ConnectorAction?,
    save: (String) -> Unit,
    cancel: () -> Unit,
) {
    val currentLabel = account.label()
    val baseline = remember(account.id) { currentLabel }
    val label = remember(account.id) { TextFieldState(initialText = baseline) }
    var showError by remember(account.id) { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val name = label.text.toString().trim()
    val errorMessage =
        when {
            name.isEmpty() -> stringResource(R.string.connector_rename_required)
            name.length > CONNECTOR_ACCOUNT_NAME_LIMIT ->
                stringResource(R.string.connector_rename_too_long, CONNECTOR_ACCOUNT_NAME_LIMIT)
            else -> null
        }
    ConnectorSheet(
        stringResource(R.string.connector_rename_title),
        cancel,
        dismissible = action?.busy != true,
        actions = {
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
        },
    ) {
        ConnectorInput(
            stringResource(R.string.connector_account_name),
            label,
            readOnly = !canModify,
            modifier = Modifier.focusRequester(focus),
            supportingText =
                stringResource(R.string.connector_rename_hint, CONNECTOR_ACCOUNT_NAME_LIMIT),
            errorMessage = errorMessage.takeIf { showError },
        )
        ConnectorActionFeedback(action)
    }
}

@Composable
internal fun ConnectorAuthorizationSheet(
    model: ConnectorModel,
    detail: ConnectorServiceDetail,
    account: ConnectorSavedAccount?,
    addingAccount: Boolean,
    canModify: Boolean,
    action: ConnectorAction?,
    cancel: () -> Unit,
) {
    val actionLabel =
        remember(account?.id) {
            when {
                account?.status == ConnectorAccountStatus.UpdatePermissions ->
                    R.string.connector_update_permissions
                account != null -> R.string.connector_reauthorize
                addingAccount -> R.string.connector_add
                else -> R.string.connector_connect
            }
        }
    val verb = stringResource(actionLabel)
    val title = stringResource(R.string.connector_authorization, verb, detail.entry.name)
    val accountLabel = account?.label()
    val step = action?.authorization
    val canDismiss = action?.busy != true
    if (action == null || step == null) {
        val methods = detail.methods.filter { account == null || it.id == account.authMethod }
        if (methods.isEmpty()) {
            ConnectorSheet(
                title,
                cancel,
                expandInShortWindow = true,
                actions = { ConnectorCloseAction(cancel) },
            ) {
                ConnectorStatusBanner(R.string.connector_unavailable)
            }
        } else {
            ConnectorMethodForm(
                title,
                accountLabel,
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
        return
    }

    val context = LocalContext.current
    val continueInBrowser = { model.openBrowser { launchConnectorBrowser(context, it) } }
    val browserOpened = action.browserOpened
    val canContinue = canDismiss && !action.reconciling
    if (step is ConnectorAuthorization.Browser) {
        LaunchedEffect(step, canContinue, browserOpened, action.problem) {
            if (canContinue && !browserOpened && action.problem == null) continueInBrowser()
        }
    }
    val code = remember((step as? ConnectorAuthorization.External)?.sessionId) { TextFieldState() }
    val submitLabel =
        when (step) {
            is ConnectorAuthorization.Browser ->
                if (browserOpened) R.string.connector_verify_authorization
                else R.string.connector_open_provider
            is ConnectorAuthorization.Device -> R.string.connector_continue_provider
            is ConnectorAuthorization.External -> R.string.connector_submit_code
            is ConnectorAuthorization.Receipt -> R.string.connector_verify_authorization
        }
    val canSubmit =
        when (step) {
            is ConnectorAuthorization.Receipt -> canDismiss
            is ConnectorAuthorization.External -> canContinue && code.text.trim().length in 1..4096
            else -> canContinue
        }
    ConnectorSheet(
        title,
        cancel,
        dismissible = canDismiss,
        expandInShortWindow = true,
        actions = {
            ConnectorFormActions(
                stringResource(submitLabel),
                enabled = canSubmit,
                cancel = cancel,
                cancelEnabled = canDismiss,
            ) {
                when (step) {
                    is ConnectorAuthorization.Browser ->
                        if (browserOpened) model.checkAuthorization() else continueInBrowser()
                    is ConnectorAuthorization.Device -> continueInBrowser()
                    is ConnectorAuthorization.External ->
                        model.completeExternal(code.text.toString())
                    is ConnectorAuthorization.Receipt -> model.checkAuthorization()
                }
            }
        },
    ) {
        ConnectorAuthorizationAccount(accountLabel)
        when (step) {
            is ConnectorAuthorization.Browser -> {
                Text(stringResource(R.string.connector_return_browser), style = connectorBodyType())
                if (browserOpened)
                    ConnectorButton(
                        stringResource(R.string.connector_open_provider),
                        continueInBrowser,
                        treatment = ConnectorButtonTreatment.Outline,
                        enabled = canContinue,
                    )
            }
            is ConnectorAuthorization.Device -> {
                Text(stringResource(R.string.connector_device_code), style = connectorBodyType())
                SelectionContainer {
                    Text(
                        step.code,
                        style =
                            MaterialTheme.typography.titleLarge.copy(
                                fontFamily = FontFamily.Monospace,
                                fontSize = 22.sp,
                                lineHeight = 28.sp,
                            ),
                    )
                }
                if (browserOpened && action.problem == null && !action.busy)
                    ConnectorProgress(R.string.connector_waiting_provider)
            }
            is ConnectorAuthorization.External -> {
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
                    readOnly = !canContinue,
                    secret = true,
                )
            }
            is ConnectorAuthorization.Receipt -> Unit
        }
        ConnectorActionFeedback(action)
    }
}

@Composable
private fun ConnectorMethodForm(
    title: String,
    accountLabel: String?,
    methods: List<ConnectorDetailConnectorAuthMethodsItem>,
    googleSecurityWarning: Boolean,
    enabled: Boolean,
    action: ConnectorAction?,
    verb: String,
    cancel: () -> Unit,
    start: (String, Map<String, String>) -> Unit,
) {
    var selectedId by remember { mutableStateOf(methods.first().id) }
    val method = methods.firstOrNull { it.id == selectedId } ?: methods.first()
    val options =
        remember(method.id) {
            mutableStateMapOf<String, String>().apply {
                method.startOptions.forEach { option ->
                    option.defaultValue?.let { put(option.id, it) }
                }
            }
        }
    val fieldIds = method.manualFields.map { it.id }
    val fields = remember(method.id, fieldIds) { fieldIds.associateWith { TextFieldState() } }
    val ready =
        method.manualFields.all { !it.required || fields.getValue(it.id).text.isNotBlank() } &&
            method.startOptions.all { !it.required || !options[it.id].isNullOrBlank() }
    val submitLabel =
        when (method.grantKind) {
            ConnectorDetailConnectorAuthMethodsItemGrantKind.NONE,
            ConnectorDetailConnectorAuthMethodsItemGrantKind.MANUAL -> verb
            else -> stringResource(R.string.connector_continue_provider)
        }
    ConnectorSheet(
        title,
        cancel,
        dismissible = action?.busy != true,
        expandInShortWindow = true,
        actions = {
            ConnectorFormActions(
                submitLabel,
                enabled =
                    enabled &&
                        ready &&
                        action?.problem != ConnectorProblem.AuthorizationUnconfirmed,
                cancel = cancel,
                cancelEnabled = action?.busy != true,
            ) {
                val values = options + fields.mapValues { it.value.text.toString() }
                start(method.id, values.filterValues { it.isNotBlank() })
            }
        },
    ) {
        ConnectorAuthorizationAccount(accountLabel)
        if (methods.size > 1) {
            Column(Modifier.fillMaxWidth().selectableGroup()) {
                for (item in methods) {
                    ConnectorChoice(item.label, item.id == method.id, enabled) {
                        selectedId = item.id
                    }
                }
            }
        }
        if (!method.description.isNullOrBlank())
            Text(method.description, style = connectorFeedbackType())
        when (method.grantKind) {
            ConnectorDetailConnectorAuthMethodsItemGrantKind.MANUAL ->
                Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    for (field in method.manualFields) {
                        key(field.id) {
                            ConnectorInput(
                                field.label,
                                fields.getValue(field.id),
                                readOnly = !enabled,
                                secret =
                                    field.inputType ==
                                        ConnectorDetailConnectorAuthMethodsItemManualFieldsItemInputType
                                            .PASSWORD,
                                placeholder = field.placeholder,
                            )
                        }
                    }
                }
            ConnectorDetailConnectorAuthMethodsItemGrantKind.NONE ->
                Text(
                    stringResource(R.string.connector_authorize_no_auth),
                    style = connectorBodyType(),
                )
            else -> {
                Text(
                    stringResource(R.string.connector_authorize_browser),
                    style = connectorBodyType(),
                )
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
                            ConnectorChoice(
                                choice.label,
                                options[option.id] == choice.value,
                                enabled,
                            ) {
                                options[option.id] = choice.value
                            }
                        }
                    }
                }
            }
        }
        ConnectorActionFeedback(action)
    }
}

@Composable
private fun ConnectorAuthorizationAccount(label: String?) {
    if (label != null)
        Text(
            label,
            style = connectorFeedbackType(),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
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
    state: TextFieldState,
    readOnly: Boolean,
    modifier: Modifier = Modifier,
    secret: Boolean = false,
    placeholder: String? = null,
    supportingText: String? = null,
    errorMessage: String? = null,
) {
    val colors = MaterialTheme.colorScheme
    val field =
        modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("connector-input").semantics {
            contentDescription = label
            if (errorMessage != null) error(errorMessage)
        }
    val shape = RoundedCornerShape(12.dp)
    val fieldColors = OutlinedTextFieldDefaults.colors(focusedBorderColor = colors.onSurface)
    val padding = PaddingValues(12.dp)
    val placeholderContent: (@Composable () -> Unit)? =
        placeholder?.let { { Text(it, style = connectorBodyType()) } }
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = connectorFeedbackType())
        Spacer(Modifier.height(8.dp))
        if (secret) {
            OutlinedSecureTextField(
                state = state,
                modifier = field,
                inputTransformation = InputTransformation { if (readOnly) revertAllChanges() },
                textObfuscationMode = TextObfuscationMode.Hidden,
                shape = shape,
                textStyle = connectorBodyType(),
                colors = fieldColors,
                placeholder = placeholderContent,
                contentPadding = padding,
            )
        } else {
            OutlinedTextField(
                state = state,
                modifier = field,
                readOnly = readOnly,
                isError = errorMessage != null,
                lineLimits = TextFieldLineLimits.SingleLine,
                shape = shape,
                textStyle = connectorBodyType(),
                colors = fieldColors,
                placeholder = placeholderContent,
                contentPadding = padding,
            )
        }
        val supportStyle =
            MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp)
        if (supportingText != null) {
            Spacer(Modifier.height(4.dp))
            Text(supportingText, style = supportStyle, color = colors.onSurfaceVariant)
        }
        if (errorMessage != null) {
            Spacer(Modifier.height(4.dp))
            Text(errorMessage, style = supportStyle, color = colors.error)
        }
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
