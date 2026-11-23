package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.SettingsSheet
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal enum class RenameStatus {
    Editing,
    Saving,
    Rejected,
    Unconfirmed,
    Checking,
}

@Composable
internal fun RenameListItemSheet(
    confirmedName: String,
    @StringRes titleRes: Int,
    @StringRes labelRes: Int,
    enabled: Boolean,
    status: RenameStatus,
    checkEnabled: Boolean,
    check: () -> Unit,
    dismiss: () -> Unit,
    saved: () -> Unit,
    save: (String) -> Boolean,
    maxLength: Int? = null,
) {
    val baseline = rememberSaveable { confirmedName.trim() }
    val input = rememberTextFieldState(initialText = confirmedName)
    var submitted by rememberSaveable { mutableStateOf<String?>(null) }
    val name = input.text.toString().trim()
    val checking = status == RenameStatus.Checking
    val unconfirmed = checking || status == RenameStatus.Unconfirmed
    val readOnly = unconfirmed || status == RenameStatus.Saving
    val confirmed = submitted != null && submitted == confirmedName && !readOnly
    LaunchedEffect(confirmed) { if (confirmed) saved() }

    val hint =
        if (maxLength == null) stringResource(R.string.chat_rename_trim_hint)
        else stringResource(R.string.connector_rename_hint, maxLength)
    val validation =
        when {
            name.isEmpty() && name != baseline -> stringResource(R.string.chat_rename_required)
            maxLength != null && name.length > maxLength -> hint
            else -> null
        }
    val canSave =
        enabled &&
            !readOnly &&
            name.isNotEmpty() &&
            validation == null &&
            name != baseline &&
            name != confirmedName.trim()
    val saveFailed = !readOnly && submitted == name && !confirmed
    val notice =
        when {
            status == RenameStatus.Saving -> R.string.settings_saving
            checking -> R.string.chat_rename_checking_result
            unconfirmed -> R.string.chat_rename_save_unconfirmed
            saveFailed || status == RenameStatus.Rejected && submitted == null ->
                R.string.chat_rename_save_failed
            else -> null
        }
    val colors = MaterialTheme.colorScheme
    val focus = remember { FocusRequester() }
    val label = stringResource(labelRes)
    SettingsSheet(
        title = stringResource(titleRes),
        onDismiss = dismiss,
        actions = {
            val actionStyle =
                MaterialTheme.typography.labelLarge.copy(
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                    fontWeight = FontWeight(550),
                )
            val target = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)
            val shape = RoundedCornerShape(12.dp)
            val padding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
            FlowRow(
                Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TextButton(
                    onClick = dismiss,
                    modifier = target,
                    shape = shape,
                    contentPadding = padding,
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface),
                ) {
                    Text(stringResource(R.string.chat_rename_cancel), style = actionStyle)
                }
                Button(
                    onClick = {
                        if (unconfirmed) check() else if (save(name)) submitted = name
                    },
                    modifier = target,
                    enabled = if (unconfirmed) checkEnabled && !checking else canSave,
                    shape = shape,
                    colors =
                        ButtonDefaults.buttonColors(
                            containerColor = colors.inverseSurface,
                            contentColor = colors.inverseOnSurface,
                            disabledContainerColor = colors.surfaceVariant,
                            disabledContentColor = colors.onSurfaceVariant,
                        ),
                    contentPadding = padding,
                ) {
                    Text(
                        stringResource(
                            if (unconfirmed) R.string.chat_rename_check_result
                            else R.string.chat_project_rename_save,
                        ),
                        style = actionStyle,
                    )
                }
            }
        },
    ) {
        Column {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                state = input,
                modifier =
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).focusRequester(focus).semantics {
                        contentDescription = label
                        if (validation != null) error(validation)
                    },
                textStyle = chatListTitleStyle(),
                readOnly = readOnly,
                isError = validation != null,
                lineLimits = TextFieldLineLimits.SingleLine,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                shape = RoundedCornerShape(12.dp),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = colors.onSurface),
                contentPadding = PaddingValues(12.dp),
            )
            LaunchedEffect(Unit) { focus.requestFocus() }
            Spacer(Modifier.height(4.dp))
            Text(
                validation ?: hint,
                color = if (validation == null) colors.onSurfaceVariant else colors.error,
                style =
                    MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
            )
            if (notice != null) {
                Spacer(Modifier.height(16.dp))
                Text(
                    stringResource(notice),
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    color =
                        if (notice == R.string.chat_rename_save_failed) colors.error
                        else colors.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}
