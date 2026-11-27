package ai.okou.android.connectors

import ai.okou.android.RenameDraft
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.coerceIn

internal class ConnectorRenameEditor(
    slug: String,
    val accountId: String,
    initialName: String,
) {
    val target = ConnectorAccountTarget(slug, accountId)
    val draft = RenameDraft(initialName)
    var focusedSelection: TextRange? = null

    fun receive(name: String, readOnly: Boolean) {
        if (draft.receive(name, readOnly)) {
            focusedSelection = focusedSelection?.coerceIn(0, name.length)
        }
    }
}
