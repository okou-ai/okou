package ai.okou.android.auth

import ai.okou.android.R
import androidx.annotation.DrawableRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.ColorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.ScaleFactor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage

@Composable
internal fun WorkspaceLogo(
    id: String,
    name: String?,
    uploadedImageUrl: String?,
    size: Dp,
) {
    val modifier = Modifier.size(size).clip(CircleShape)
    if (uploadedImageUrl != null) {
        val neutralTile = ColorPainter(MaterialTheme.colorScheme.surfaceContainerHighest)
        AsyncImage(
            model = uploadedImageUrl,
            contentDescription = null,
            modifier = modifier,
            placeholder = neutralTile,
            error = neutralTile,
            contentScale = ContentScale.Crop,
        )
        return
    }

    val colorway = remember(id) { workspaceColorway(id) }
    val initial = remember(name) { name?.let(::workspaceInitial) }
    // The containing row or button supplies the complete workspace name.
    Box(modifier.clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
        Image(
            painterResource(colorway.texture),
            contentDescription = null,
            modifier = Modifier.matchParentSize(),
            contentScale = workspaceTextureCrop,
        )
        if (initial != null) {
            val ratio = if (wideScript.containsMatchIn(initial)) 0.44f else 0.5f
            Text(
                initial,
                color = colorway.letter,
                fontSize = with(LocalDensity.current) { (size * ratio).toSp() },
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.sp,
                style =
                    MaterialTheme.typography.titleMedium.copy(lineHeight = TextUnit.Unspecified),
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}

private val generatedWorkspaceName = Regex("workspace-[0-9a-f]{8}", RegexOption.IGNORE_CASE)
private val grapheme = Regex("\\X")
private val letterOrNumber = Regex("[\\p{L}\\p{N}]")
private val wideScript = Regex("[\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}]")

internal fun workspaceInitial(name: String): String? {
    val trimmed = name.trim()
    if (generatedWorkspaceName.matches(trimmed)) return null
    val initial =
        grapheme.findAll(trimmed).firstOrNull { letterOrNumber.containsMatchIn(it.value) }?.value
            ?: return null
    val uppercase = initial.uppercase()
    // Keep the first grapheme whole, including initials such as ß that expand in uppercase.
    return if (grapheme.matches(uppercase)) uppercase else initial
}

private data class WorkspaceColorway(@DrawableRes val texture: Int, val letter: Color)

// Web displays the shared texture at 160%, centered inside the workspace tile.
private val workspaceTextureCrop = ContentScale { source, destination ->
    val crop = ContentScale.Crop.computeScaleFactor(source, destination)
    ScaleFactor(crop.scaleX * 1.6f, crop.scaleY * 1.6f)
}

// Match the Web colorway order and letter colors in core/src/workspace-logo.ts.
private val workspaceColorways =
    listOf(
        WorkspaceColorway(R.drawable.avatar_texture_dash_pink_pink, Color(0xFF6E485B)),
        WorkspaceColorway(R.drawable.avatar_texture_dash_coral_red, Color(0xFF480000)),
        WorkspaceColorway(R.drawable.avatar_texture_drop_lightblue_blue, Color(0xFF395766)),
        WorkspaceColorway(R.drawable.avatar_texture_drop_blue_navy, Color(0xFFD9ECFF)),
        WorkspaceColorway(R.drawable.avatar_texture_loop_yellow_orange, Color(0xFF675900)),
        WorkspaceColorway(R.drawable.avatar_texture_loop_orange_amber, Color(0xFF6E2F00)),
        WorkspaceColorway(R.drawable.avatar_texture_stripe_lime_green, Color(0xFF465900)),
        WorkspaceColorway(R.drawable.avatar_texture_stripe_teal_pine, Color(0xFFEAFFFE)),
    )

private fun workspaceColorway(id: String): WorkspaceColorway {
    // FNV-1a over UTF-16, matching the Web and iOS clients.
    val hash = id.fold(2_166_136_261u) { hash, char -> (hash xor char.code.toUInt()) * 16_777_619u }
    return workspaceColorways[(hash % workspaceColorways.size.toUInt()).toInt()]
}
