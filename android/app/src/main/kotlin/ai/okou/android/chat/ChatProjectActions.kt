package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.SettingsSheet
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

@Composable
internal fun projectMoveLabel(destination: ChatProjectDestination?): String =
    when {
        destination == null -> stringResource(R.string.chat_move_project)
        destination.name == null -> stringResource(R.string.chat_move_project_outside)
        else -> stringResource(R.string.chat_move_project_named, destination.name)
    }

@Composable
internal fun ProjectMovePicker(
    destinations: List<ChatProjectDestination>,
    dismiss: () -> Unit,
    move: (String?) -> Unit,
) {
    SettingsSheet(stringResource(R.string.chat_move_project), dismiss) {
        for (destination in destinations) {
            Row(
                Modifier.fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .clickable(role = Role.Button) { move(destination.id) }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    painterResource(
                        if (destination.id == null) R.drawable.ic_folder_open
                        else R.drawable.ic_folder
                    ),
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    destination.name ?: stringResource(R.string.chat_project_outside),
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
        }
    }
}
