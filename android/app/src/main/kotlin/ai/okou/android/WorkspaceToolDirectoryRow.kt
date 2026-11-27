package ai.okou.android

import ai.okou.android.updates.updateFocusOutline
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val rowShape = RoundedCornerShape(8.dp)
private val mediaShape = RoundedCornerShape(12.dp)
private val rowBounds = Modifier.fillMaxWidth().heightIn(min = 80.dp)
private val trailingSize = 18.dp

@Composable
internal fun WorkspaceToolDirectoryRow(
    title: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    leading: @Composable () -> Unit,
    supportingContent: @Composable (Color) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val foreground = if (selected) colors.onSecondaryContainer else colors.onBackground
    WorkspaceToolDirectoryRowLayout(
        modifier
            .then(rowBounds)
            .clip(rowShape)
            .then(if (selected) Modifier.background(colors.secondaryContainer) else Modifier)
            .updateFocusOutline(rowShape, foreground, keyboardOnly = true)
            .selectable(selected, enabled = enabled, role = Role.Button, onClick = onClick),
        leading = leading,
        trailing = {
            Icon(
                painterResource(R.drawable.ic_chevron_right),
                contentDescription = null,
                modifier = Modifier.align(Alignment.CenterVertically).size(trailingSize),
                tint = foreground,
            )
        },
    ) {
        Text(
            title,
            style = MaterialTheme.typography.bodyLarge.copy(letterSpacing = 0.sp),
            fontWeight = FontWeight.SemiBold,
            color = foreground,
        )
        supportingContent(if (selected) foreground else colors.onSurfaceVariant)
    }
}

@Composable
internal fun WorkspaceToolDirectoryRowSkeleton(content: @Composable () -> Unit) {
    WorkspaceToolDirectoryRowLayout(
        rowBounds,
        leading = {},
        trailing = { Spacer(Modifier.size(trailingSize)) },
        content = content,
    )
}

@Composable
private fun WorkspaceToolDirectoryRowLayout(
    modifier: Modifier,
    leading: @Composable () -> Unit,
    trailing: @Composable RowScope.() -> Unit,
    content: @Composable () -> Unit,
) {
    Row(
        modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(40.dp)
                .clip(mediaShape)
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            leading()
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            content()
        }
        trailing()
    }
}
