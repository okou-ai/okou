package ai.okou.android.connectors

import ai.okou.android.NativeAboveLabelPadding
import ai.okou.android.OkouFormActions
import ai.okou.android.OkouFormFieldSupport
import ai.okou.android.OkouFormLayout
import ai.okou.android.R
import ai.okou.android.RenameFieldError
import ai.okou.android.SettingsChoiceRow
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItem
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItemGrantKind
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItemManualFieldsItemInputType
import ai.okou.android.chat.ContentReadFeedback
import ai.okou.android.okouFormInputStyle
import ai.okou.android.okouFormLabelHeight
import ai.okou.android.okouFormSupportingLineHeight
import ai.okou.android.okouFormSupportingTextHeight
import ai.okou.android.updates.updateFocusOutline
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldLabelPosition
import androidx.compose.material3.TextFieldLabelScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import kotlinx.coroutines.flow.filterNotNull
import okhttp3.HttpUrl

@Composable
internal fun ConnectorRenameSheet(
    editor: ConnectorRenameEditor,
    confirmedLabel: String?,
    canModify: Boolean,
    action: ConnectorAction?,
    save: (String) -> Unit,
    cancel: () -> Unit,
    readFeedback: SnackbarHostState,
) {
    val draft = editor.draft
    LaunchedEffect(editor, confirmedLabel, action?.busy) {
        if (confirmedLabel != null) editor.receive(confirmedLabel, readOnly = action?.busy == true)
    }
    val form = draft.form(confirmedLabel, canModify, CONNECTOR_ACCOUNT_NAME_LIMIT)
    val errorMessage =
        when (form.error) {
            RenameFieldError.Required -> stringResource(R.string.connector_rename_required)
            RenameFieldError.TooLong ->
                stringResource(R.string.connector_rename_too_long, CONNECTOR_ACCOUNT_NAME_LIMIT)
            null -> null
        }
    val saving = action?.busy == true
    val problem = action?.problem
    val saveFailureMessage = stringResource(R.string.chat_rename_save_failed)
    val supportingLineHeight = okouFormSupportingLineHeight(saveFailureMessage)
    val feedback =
        when {
            problem == ConnectorProblem.Failed -> saveFailureMessage
            problem != null -> stringResource(connectorActionProblemMessage(problem))
            else -> null
        }
    val colors = MaterialTheme.colorScheme
    val saveLabel = stringResource(R.string.instructions_save)
    val savingLabel = stringResource(R.string.settings_saving)
    ConnectorSheet(
        stringResource(R.string.connector_rename_title),
        cancel,
        dismissible = action?.busy != true,
        compactForm = true,
        feedback = readFeedback,
        actions = {
            OkouFormActions(
                cancelLabel = stringResource(R.string.settings_cancel),
                confirmLabel = if (saving) savingLabel else saveLabel,
                cancel = cancel,
                confirm = { save(form.name) },
                confirmEnabled = form.canSave,
                modifier = Modifier.padding(top = OkouFormLayout.ActionGap),
                cancelEnabled = action?.busy != true,
                confirmLayoutLabels = listOf(saveLabel, savingLabel),
                useMaterialButtonDefaults = true,
            )
        },
    ) {
        val focus = remember { FocusRequester() }
        var fieldFocused by remember { mutableStateOf(false) }
        ConnectorInput(
            stringResource(R.string.connector_account_name),
            draft.input,
            readOnly = !canModify,
            modifier =
                Modifier.focusRequester(focus).onFocusChanged { fieldFocused = it.isFocused },
            showLabel = false,
            supportingText = {
                OkouFormFieldSupport(
                    errorMessage ?: feedback,
                    if (errorMessage != null || feedback != null) colors.error
                    else colors.onSurfaceVariant,
                    Modifier.animateContentSize().heightIn(min = supportingLineHeight),
                )
            },
            errorMessage = errorMessage ?: feedback,
        )
        LaunchedEffect(editor) {
            editor.focusedSelection?.let { selection ->
                focus.requestFocus()
                if (draft.input.selection != selection)
                    draft.input.edit { this.selection = selection }
            }
            // Window teardown may collapse the native selection after the field loses focus.
            snapshotFlow { draft.input.selection.takeIf { fieldFocused } }
                .filterNotNull()
                .collect { editor.focusedSelection = it }
        }
    }
}

@Composable
internal fun ConnectorAuthorizationSheet(
    model: ConnectorModel,
    service: String,
    detail: ConnectorRead<ConnectorServiceDetail>,
    account: ConnectorSavedAccount?,
    addingAccount: Boolean,
    canModify: Boolean,
    action: ConnectorAction?,
    cancel: () -> Unit,
    readFeedback: SnackbarHostState,
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
    val chosenOptions = remember(method?.id) { mutableStateMapOf<String, String>() }
    val options =
        method
            ?.startOptions
            .orEmpty()
            .mapNotNull { option ->
                val value = chosenOptions[option.id] ?: option.defaultValue
                option.options.find { it.value == value }?.let { option.id to it.value }
            }
            .toMap()
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
    val externalCodeSessionId =
        when (step) {
            is ConnectorAuthorization.External -> step.sessionId
            is ConnectorAuthorization.Receipt -> step.externalCodeSessionId
            else -> null
        }
    val code = remember(externalCodeSessionId) { TextFieldState() }
    val codeLength = code.text.trim().length
    val checkingCode = externalCodeSessionId != null && !canDismiss
    val awaitingExternalReceipt = action?.awaitingExternalReceipt == true
    val submitLabel =
        when (step) {
            is ConnectorAuthorization.Browser ->
                if (browserOpened) R.string.connector_verify_authorization
                else R.string.connector_open_provider
            is ConnectorAuthorization.Device -> R.string.connector_continue_provider
            is ConnectorAuthorization.External ->
                when {
                    checkingCode -> R.string.connector_checking_code
                    awaitingExternalReceipt -> R.string.connector_verify_authorization
                    else -> R.string.connector_submit_code
                }
            is ConnectorAuthorization.Receipt ->
                if (checkingCode) R.string.connector_checking_code
                else R.string.connector_verify_authorization
            is ConnectorAuthorization.DeviceVerification -> R.string.connector_verify_authorization
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
            is ConnectorAuthorization.Receipt,
            is ConnectorAuthorization.DeviceVerification -> canDismiss
            is ConnectorAuthorization.External ->
                canContinue &&
                    (awaitingExternalReceipt || codeLength in 1..CONNECTOR_EXTERNAL_CODE_LIMIT)
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
        compactForm = true,
        feedback = readFeedback,
        actions = {
            OkouFormActions(
                cancelLabel = stringResource(R.string.settings_cancel),
                confirmLabel = submitLabel?.let { stringResource(it) },
                cancel = cancel,
                confirm = {
                    when (step) {
                        is ConnectorAuthorization.Browser ->
                            if (browserOpened) model.checkAuthorization() else continueInBrowser()
                        is ConnectorAuthorization.Device -> continueInBrowser()
                        is ConnectorAuthorization.External ->
                            if (awaitingExternalReceipt) model.checkExternalAuthorization()
                            else model.completeExternal(code.text.toString())
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
                },
                confirmEnabled = canSubmit,
                modifier = Modifier.padding(top = OkouFormLayout.ActionGap),
                cancelEnabled = canDismiss,
                confirmLayoutLabels =
                    if (externalCodeSessionId == null) emptyList()
                    else
                        listOf(
                            stringResource(R.string.connector_submit_code),
                            stringResource(R.string.connector_checking_code),
                            stringResource(R.string.connector_verify_authorization),
                        ),
                keepConfirmFocusWhilePending = checkingCode,
                useMaterialButtonDefaults = true,
            )
        },
    ) {
        ConnectorAuthorizationAccount(accountLabel)
        when (step) {
            null ->
                if (method == null) {
                    when {
                        detail.data != null -> ConnectorStatusBanner(R.string.connector_unavailable)
                        detail.failure != null ->
                            ContentReadFeedback(R.string.connector_load_failed)
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
                        onChooseOption = { id, value -> chosenOptions[id] = value },
                        googleSecurityWarning = detail.data?.googleSecurityWarning == true,
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
            is ConnectorAuthorization.External,
            is ConnectorAuthorization.Receipt ->
                if (externalCodeSessionId != null) {
                    ConnectorExternalCodeForm(
                        code,
                        tooLong = codeLength > CONNECTOR_EXTERNAL_CODE_LIMIT,
                        editable =
                            step is ConnectorAuthorization.External &&
                                canContinue &&
                                !awaitingExternalReceipt,
                        problem = action?.problem.takeIf { canDismiss },
                        openProvider = continueInBrowser,
                    )
                }
            is ConnectorAuthorization.DeviceVerification -> Unit
        }
        if (externalCodeSessionId == null) ConnectorActionFeedback(action)
    }
}

@Composable
private fun ConnectorExternalCodeForm(
    code: TextFieldState,
    tooLong: Boolean,
    editable: Boolean,
    problem: ConnectorProblem?,
    openProvider: () -> Unit,
) {
    val lengthError =
        stringResource(R.string.connector_external_code_too_long, CONNECTOR_EXTERNAL_CODE_LIMIT)
    val errorMessage =
        when {
            tooLong -> lengthError
            problem == ConnectorProblem.Failed ->
                stringResource(R.string.connector_external_code_failed)
            problem == ConnectorProblem.Network || problem == ConnectorProblem.BrowserUnavailable ->
                stringResource(connectorActionProblemMessage(problem))
            else -> null
        }
    val colors = MaterialTheme.colorScheme
    Text(stringResource(R.string.connector_external_instructions), style = connectorBodyType())
    ConnectorButton(
        stringResource(R.string.connector_open_provider),
        openProvider,
        treatment = ConnectorButtonTreatment.Outline,
        enabled = editable,
    )
    ConnectorInput(
        stringResource(R.string.connector_external_code),
        code,
        readOnly = !editable,
        secret = true,
        supportingText = {
            Box {
                OkouFormFieldSupport(
                    lengthError,
                    colors.onSurfaceVariant,
                    Modifier.clearAndSetSemantics {}.alpha(0f),
                )
                OkouFormFieldSupport(
                    errorMessage
                        ?: problem?.let { stringResource(connectorActionProblemMessage(it)) },
                    if (errorMessage == null) colors.onSurfaceVariant else colors.error,
                )
            }
        },
        errorMessage = errorMessage,
    )
}

@Composable
private fun ConnectorMethodFields(
    method: ConnectorDetailConnectorAuthMethodsItem,
    enabled: Boolean,
    fields: Map<String, TextFieldState>,
    options: Map<String, String>,
    onChooseOption: (String, String) -> Unit,
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
                        SettingsChoiceRow(
                            choice.label,
                            options[option.id] == choice.value,
                            enabled,
                            onClick = { onChooseOption(option.id, choice.value) },
                        )
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
    val shape = RoundedCornerShape(12.dp)
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(shape)
            .updateFocusOutline(shape, MaterialTheme.colorScheme.onSurface, keyboardOnly = true)
            .selectable(selected, enabled = enabled, role = Role.RadioButton, onClick = choose)
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(
            selected,
            onClick = null,
            enabled = enabled,
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
    showLabel: Boolean = true,
    placeholder: String? = null,
    supportingText: (@Composable () -> Unit)? = null,
    errorMessage: String? = null,
) {
    val supportHeight =
        if (supportingText != null)
            okouFormSupportingTextHeight() + OkouFormLayout.SupportingTextGap
        else 0.dp
    val labelStyle = MaterialTheme.typography.bodySmall
    val fieldLabel: (@Composable TextFieldLabelScope.() -> Unit)? =
        if (showLabel) {
            { Text(label, style = labelStyle) }
        } else null
    val placeholderContent: (@Composable () -> Unit)? = placeholder?.let {
        { Text(it, style = connectorBodyType()) }
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val labelHeight =
            if (showLabel)
                okouFormLabelHeight(
                    label,
                    constraints.maxWidth,
                    labelStyle,
                    NativeAboveLabelPadding,
                )
            else 0.dp
        val field =
            modifier
                .fillMaxWidth()
                .heightIn(min = OutlinedTextFieldDefaults.MinHeight + supportHeight + labelHeight)
                .testTag("connector-input")
                .semantics {
                    contentDescription = label
                    if (errorMessage != null) error(errorMessage)
                }
        if (secret) {
            OutlinedSecureTextField(
                state = state,
                modifier = field,
                inputTransformation = InputTransformation { if (readOnly) revertAllChanges() },
                textObfuscationMode = TextObfuscationMode.Hidden,
                labelPosition = TextFieldLabelPosition.Above(),
                label = fieldLabel,
                isError = errorMessage != null,
                supportingText = supportingText,
                textStyle = okouFormInputStyle(),
                placeholder = placeholderContent,
            )
        } else {
            OutlinedTextField(
                state = state,
                modifier = field,
                readOnly = readOnly,
                labelPosition = TextFieldLabelPosition.Above(),
                label = fieldLabel,
                isError = errorMessage != null,
                supportingText = supportingText,
                lineLimits = TextFieldLineLimits.SingleLine,
                textStyle = okouFormInputStyle(),
                placeholder = placeholderContent,
            )
        }
    }
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
