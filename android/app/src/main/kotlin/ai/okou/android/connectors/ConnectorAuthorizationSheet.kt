package ai.okou.android.connectors

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.OkouFormActions
import ai.okou.android.OkouFormLayout
import ai.okou.android.R
import ai.okou.android.RenameFieldError
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItem
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItemGrantKind
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItemManualFieldsItemInputType
import ai.okou.android.okouFormInputStyle
import ai.okou.android.renameForm
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
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
    val form =
        renameForm(label.text, baseline, currentLabel, canModify, CONNECTOR_ACCOUNT_NAME_LIMIT)
    val errorMessage =
        when (form.error) {
            RenameFieldError.Required -> stringResource(R.string.connector_rename_required)
            RenameFieldError.TooLong ->
                stringResource(R.string.connector_rename_too_long, CONNECTOR_ACCOUNT_NAME_LIMIT)
            null -> null
        }
    ConnectorSheet(
        stringResource(R.string.connector_rename_title),
        cancel,
        dismissible = action?.busy != true,
        actions = {
            ConnectorFormActions(
                stringResource(R.string.instructions_save),
                enabled = form.canSave,
                cancel = cancel,
                cancelEnabled = action?.busy != true,
            ) {
                save(form.name)
            }
        },
    ) {
        ConnectorInput(
            stringResource(R.string.connector_account_name),
            label,
            readOnly = !canModify,
            supportingText =
                stringResource(R.string.connector_rename_hint, CONNECTOR_ACCOUNT_NAME_LIMIT),
            errorMessage = errorMessage,
        )
        ConnectorActionFeedback(action)
    }
}

@Composable
internal fun ConnectorAuthorizationSheet(
    model: ConnectorModel,
    service: String,
    detail: ConnectorRead<ConnectorServiceDetail>,
    offline: Boolean,
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
    val title = stringResource(R.string.connector_authorization, verb, service)
    val accountLabel = account?.label()
    val step = action?.authorization.takeIf { detail.data != null }
    val canDismiss = action?.busy != true
    val methods =
        detail.data?.methods.orEmpty().filter { account == null || it.id == account.authMethod }
    var selectedId by remember(service, account?.id) { mutableStateOf<String?>(null) }
    val method = methods.firstOrNull { it.id == selectedId } ?: methods.firstOrNull()
    val options =
        remember(method?.id) {
            mutableStateMapOf<String, String>().apply {
                method?.startOptions.orEmpty().forEach { option ->
                    option.defaultValue?.let { put(option.id, it) }
                }
            }
        }
    val fields =
        if (step == null) {
            val fieldIds = method?.manualFields.orEmpty().map { it.id }
            remember(method?.id, fieldIds) { fieldIds.associateWith { TextFieldState() } }
        } else emptyMap()

    val context = LocalContext.current
    val continueInBrowser = { model.openBrowser { launchConnectorBrowser(context, it) } }
    val browserOpened = action?.browserOpened == true
    val canContinue = canDismiss && action?.reconciling != true
    if (step is ConnectorAuthorization.Browser) {
        LaunchedEffect(step, canContinue, browserOpened, action?.problem) {
            if (canContinue && !browserOpened && action?.problem == null) continueInBrowser()
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
            is ConnectorAuthorization.DeviceVerification,
            is ConnectorAuthorization.Receipt -> R.string.connector_verify_authorization
            null ->
                when (method?.grantKind) {
                    null -> null
                    ConnectorDetailConnectorAuthMethodsItemGrantKind.NONE,
                    ConnectorDetailConnectorAuthMethodsItemGrantKind.MANUAL -> actionLabel
                    else -> R.string.connector_continue_provider
                }
        }
    val canSubmit =
        when (step) {
            is ConnectorAuthorization.Receipt -> canDismiss
            is ConnectorAuthorization.DeviceVerification -> canDismiss && !offline
            is ConnectorAuthorization.External -> canContinue && code.text.trim().length in 1..4096
            null ->
                canModify &&
                    action?.problem != ConnectorProblem.AuthorizationUnconfirmed &&
                    method != null &&
                    method.manualFields.all {
                        !it.required || fields.getValue(it.id).text.isNotBlank()
                    } &&
                    method.startOptions.all { !it.required || !options[it.id].isNullOrBlank() }
            else -> canContinue
        }
    ConnectorSheet(
        title,
        cancel,
        dismissible = canDismiss,
        expandInShortWindow = true,
        actions = {
            ConnectorFormActions(
                submitLabel?.let { stringResource(it) },
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
                    is ConnectorAuthorization.DeviceVerification,
                    is ConnectorAuthorization.Receipt -> model.checkAuthorization()
                    null ->
                        if (method != null) {
                            val values = options + fields.mapValues { it.value.text.toString() }
                            model.startAuthorization(
                                account?.id,
                                method.id,
                                values.filterValues { it.isNotBlank() },
                            )
                        }
                }
            }
        },
    ) {
        ConnectorAuthorizationAccount(accountLabel)
        when (step) {
            null ->
                if (method == null) {
                    when {
                        detail.data != null -> ConnectorStatusBanner(R.string.connector_unavailable)
                        detail.failure == ConnectorReadFailure.Unavailable ->
                            ConnectorReadError(R.string.connector_load_failed)
                        offline -> ConnectorLoadWhenOnline()
                        detail.failure != null -> ConnectorReadError(R.string.connector_load_failed)
                        else ->
                            ConnectorSkeleton(stringResource(R.string.connector_loading), rows = 1)
                    }
                } else {
                    if (methods.size > 1) {
                        Column(Modifier.fillMaxWidth().selectableGroup()) {
                            for (item in methods) {
                                ConnectorChoice(item.label, item.id == method.id, canModify) {
                                    selectedId = item.id
                                }
                            }
                        }
                    }
                    ConnectorMethodFields(
                        method,
                        canModify,
                        fields,
                        options,
                        detail.data?.googleSecurityWarning == true,
                    )
                }
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
                if (browserOpened && action.problem == null && canDismiss)
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
            is ConnectorAuthorization.DeviceVerification,
            is ConnectorAuthorization.Receipt -> Unit
        }
        ConnectorActionFeedback(action)
    }
}

@Composable
private fun ConnectorMethodFields(
    method: ConnectorDetailConnectorAuthMethodsItem,
    enabled: Boolean,
    fields: Map<String, TextFieldState>,
    options: MutableMap<String, String>,
    googleSecurityWarning: Boolean,
) {
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
        modifier
            .fillMaxWidth()
            .heightIn(min = OutlinedTextFieldDefaults.MinHeight)
            .testTag("connector-input")
            .semantics {
                contentDescription = label
                if (errorMessage != null) error(errorMessage)
            }
    val shape = MaterialTheme.shapes.medium
    val fieldColors = OutlinedTextFieldDefaults.colors(focusedBorderColor = colors.onSurface)
    val padding = OkouFormLayout.FieldPadding
    val placeholderContent: (@Composable () -> Unit)? = placeholder?.let {
        { Text(it, style = connectorBodyType()) }
    }
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = connectorFeedbackType())
        Spacer(Modifier.height(OkouFormLayout.LabelGap))
        if (secret) {
            OutlinedSecureTextField(
                state = state,
                modifier = field,
                inputTransformation = InputTransformation { if (readOnly) revertAllChanges() },
                textObfuscationMode = TextObfuscationMode.Hidden,
                shape = shape,
                textStyle = okouFormInputStyle(),
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
                textStyle = okouFormInputStyle(),
                colors = fieldColors,
                placeholder = placeholderContent,
                contentPadding = padding,
            )
        }
        val supportStyle =
            MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp)
        if (supportingText != null) {
            Spacer(Modifier.height(OkouFormLayout.SupportingTextGap))
            Text(supportingText, style = supportStyle, color = colors.onSurfaceVariant)
        }
        if (errorMessage != null) {
            Spacer(Modifier.height(OkouFormLayout.SupportingTextGap))
            Text(errorMessage, style = supportStyle, color = colors.error)
        }
    }
}

@Composable
private fun ConnectorFormActions(
    label: String?,
    enabled: Boolean,
    cancel: () -> Unit,
    cancelEnabled: Boolean,
    submit: () -> Unit,
) {
    OkouFormActions(
        cancelLabel = stringResource(R.string.settings_cancel),
        confirmLabel = label,
        cancel = cancel,
        confirm = submit,
        confirmEnabled = enabled,
        modifier = Modifier.padding(top = OkouFormLayout.ActionGap),
        cancelEnabled = cancelEnabled,
    )
}

private fun launchConnectorBrowser(context: Context, url: HttpUrl): Boolean =
    try {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, url.toString().toUri())
                .addCategory(Intent.CATEGORY_BROWSABLE),
        )
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }
