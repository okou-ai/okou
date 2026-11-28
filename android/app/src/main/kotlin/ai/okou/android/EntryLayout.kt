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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal val EntryContentWidth = 360.dp
internal val EntryContentGutter = 18.dp

private val regularBrandMark = 64.dp
private val regularBrandGap = 12.dp
private val compactBrandMark = 40.dp
private val compactBrandGap = 8.dp
private val compactBrandMinHeight = 48.dp

internal fun entrySpacing(compact: Boolean) = if (compact) 12.dp else 24.dp

internal fun entryTopPadding(windowHeight: Int) =
    if (isShortWindowHeight(windowHeight)) 12.dp else (windowHeight * 0.08f).coerceIn(32f, 80f).dp

@Composable
internal fun entryTitleStyle(compact: Boolean) =
    (if (compact) MaterialTheme.typography.titleLarge else MaterialTheme.typography.headlineMedium)
        .copy(fontWeight = FontWeight(650))

@Composable
internal fun entryBrandNameStyle(compact: Boolean) =
    if (compact) MaterialTheme.typography.titleLarge else MaterialTheme.typography.headlineLarge

@Composable
internal fun measureEntryBrandHeight(compact: Boolean, width: Dp, measurer: TextMeasurer): Dp {
    val name = stringResource(R.string.app_name)
    val style = entryBrandNameStyle(compact)
    val nameWidth = if (compact) width - compactBrandMark - compactBrandGap else width
    return with(LocalDensity.current) {
        val nameHeight =
            measurer
                .measure(
                    name,
                    style,
                    constraints = Constraints(maxWidth = nameWidth.roundToPx().coerceAtLeast(0)),
                )
                .size
                .height
                .toDp()
        if (compact) maxOf(compactBrandMinHeight, nameHeight)
        else regularBrandMark + regularBrandGap + nameHeight
    }
}

@Composable
internal fun EntryBrand(
    compact: Boolean,
    modifier: Modifier = Modifier,
    nameStyle: TextStyle = entryBrandNameStyle(compact),
) {
    val mark: @Composable () -> Unit = {
        Image(
            painterResource(R.drawable.okou_entry_mark),
            contentDescription = null,
            modifier = Modifier.size(if (compact) compactBrandMark else regularBrandMark),
        )
    }
    val name: @Composable () -> Unit = {
        Text(stringResource(R.string.app_name), style = nameStyle)
    }
    if (compact) {
        Row(
            modifier.heightIn(min = compactBrandMinHeight),
            horizontalArrangement = Arrangement.spacedBy(compactBrandGap),
        ) {
            mark()
            Box(
                Modifier.heightIn(min = compactBrandMark),
                contentAlignment = Alignment.CenterStart,
            ) {
                name()
            }
        }
    } else {
        Column(
            modifier,
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(regularBrandGap),
        ) {
            mark()
            name()
        }
    }
}
