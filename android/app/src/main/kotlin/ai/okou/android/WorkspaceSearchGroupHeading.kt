package ai.okou.android

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun WorkspaceSearchGroupHeading(
    label: String,
    modifier: Modifier = Modifier,
    topPadding: Dp = 10.dp,
) {
    Text(
        label,
        modifier.padding(top = topPadding, bottom = 4.dp).semantics { heading() },
        style = workspaceSearchSecondaryStyle().copy(fontWeight = FontWeight.SemiBold),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
internal fun workspaceSearchSecondaryStyle() =
    MaterialTheme.typography.bodyMedium.copy(
        fontSize = 13.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.sp,
    )
