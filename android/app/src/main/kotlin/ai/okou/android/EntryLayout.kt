package ai.okou.android

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

internal const val EntryCompactHeight = 480
internal val EntryContentWidth = 360.dp
internal val EntryContentGutter = 18.dp

internal fun entrySpacing(compact: Boolean) = if (compact) 12.dp else 24.dp

internal fun entryTopPadding(windowHeight: Int) =
    if (windowHeight < EntryCompactHeight) 12.dp else (windowHeight * 0.08f).coerceIn(32f, 80f).dp

@Composable
internal fun entryTitleStyle(compact: Boolean) =
    (if (compact) MaterialTheme.typography.titleLarge else MaterialTheme.typography.headlineMedium)
        .copy(fontWeight = FontWeight(650))

@Composable
internal fun EntryBrand(compact: Boolean, modifier: Modifier = Modifier) {
    val typography = MaterialTheme.typography
    val mark: @Composable () -> Unit = {
        Image(
            painterResource(R.drawable.okou_mark),
            contentDescription = null,
            modifier = Modifier.size(if (compact) 40.dp else 64.dp),
        )
    }
    val name: @Composable () -> Unit = {
        Text(
            stringResource(R.string.app_name),
            style = if (compact) typography.titleLarge else typography.headlineLarge,
        )
    }
    if (compact) {
        Row(
            modifier.heightIn(min = 48.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            mark()
            Box(Modifier.heightIn(min = 40.dp), contentAlignment = Alignment.CenterStart) { name() }
        }
    } else {
        Column(
            modifier,
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            mark()
            name()
        }
    }
}
