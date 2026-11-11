package ai.okou.android

import ai.okou.ccstate.compose.Loadable
import ai.okou.ccstate.compose.StoreProvider
import ai.okou.ccstate.compose.observeAsState
import ai.okou.ccstate.compose.rememberCommand
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

@Composable
fun FoundationScreen(model: FoundationModel) {
    StoreProvider(model.store) {
        val draft by observeAsState(model.draft)
        val allowed by observeAsState(model.canPreview)
        val preview by observeAsState(model.lastPreview)
        val replace = rememberCommand(model.replaceDraft)
        val showPreview = rememberCommand(model.previewDraft)
        Scaffold { insets ->
            Column(
                Modifier.fillMaxSize()
                    .padding(insets)
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    stringResource(R.string.foundation_title),
                    style = MaterialTheme.typography.headlineLarge,
                )
                Text(stringResource(R.string.foundation_description))
                when (val current = draft) {
                    is Loadable.Data ->
                        OutlinedTextField(
                            value = current.value,
                            onValueChange = replace,
                            label = { Text(stringResource(R.string.draft_label)) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    is Loadable.Error -> Text(stringResource(R.string.state_error))
                    Loadable.Loading -> Unit
                }
                Button(
                    onClick = { showPreview(Unit) },
                    enabled = (allowed as? Loadable.Data)?.value == true,
                ) {
                    Text(stringResource(R.string.local_preview))
                }
                (preview as? Loadable.Data)?.value?.let {
                    Text(stringResource(R.string.draft_preview, it))
                }
            }
        }
    }
}
