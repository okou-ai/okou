package ai.okou.android

import ai.okou.android.foundation.DraftUiState
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun FoundationScreen(model: FoundationModel) {
    val state by model.uiState.collectAsStateWithLifecycle()
    DraftScreen(state, model::replaceDraft, model::previewDraft)
}

@Composable
private fun DraftScreen(
    state: DraftUiState,
    replaceDraft: (String) -> Unit,
    previewDraft: () -> Unit,
) {
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
            OutlinedTextField(
                value = state.text,
                onValueChange = replaceDraft,
                label = { Text(stringResource(R.string.draft_label)) },
                modifier = Modifier.fillMaxWidth(),
            )
            Button(onClick = previewDraft, enabled = state.canPreview) {
                Text(stringResource(R.string.local_preview))
            }
            state.preview?.let { Text(stringResource(R.string.draft_preview, it)) }
        }
    }
}
