package ai.okou.android

import ai.okou.android.updates.updateFocusOutline
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

private val mediaShape = RoundedCornerShape(12.dp)
private val trailingSize = 18.dp

@Composable
internal fun workspaceToolListItemShapes(): androidx.compose.material3.ListItemShapes {
    val activeShape = MaterialTheme.shapes.extraLarge
    return ListItemDefaults.shapes(
        selectedShape = activeShape,
        pressedShape = activeShape,
        focusedShape = activeShape,
    )
}

@Composable
internal fun WorkspaceToolDirectoryRow(
    title: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    leading: @Composable () -> Unit,
    supportingContent: @Composable (() -> Unit)? = null,
) {
    val shapes = workspaceToolListItemShapes()
    val colors = ListItemDefaults.colors()
    val foreground = if (selected) colors.selectedContentColor else colors.contentColor
    ListItem(
        selected = selected,
        onClick = onClick,
        modifier =
            modifier
                .fillMaxWidth()
                .semantics { role = Role.Button }
                .updateFocusOutline(shapes.focusedShape, foreground, keyboardOnly = true),
        enabled = enabled,
        leadingContent = { DirectoryRowMedia(leading) },
        trailingContent = {
            Icon(
                painterResource(R.drawable.ic_chevron_right),
                contentDescription = null,
                modifier = Modifier.size(trailingSize),
            )
        },
        supportingContent = supportingContent,
        shapes = shapes,
        colors = colors,
    ) {
        Text(title)
    }
}

@Composable
internal fun WorkspaceToolDirectoryRowSkeleton(
    modifier: Modifier = Modifier,
    supportingContent: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    ListItem(
        modifier = modifier.fillMaxWidth(),
        leadingContent = { DirectoryRowMedia {} },
        trailingContent = { Spacer(Modifier.size(trailingSize)) },
        supportingContent = supportingContent,
        content = content,
    )
}

@Composable
private fun DirectoryRowMedia(content: @Composable () -> Unit) {
    Box(
        Modifier.size(40.dp).clip(mediaShape).background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}
