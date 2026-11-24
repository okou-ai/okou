package ai.okou.android

import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.preferences.languageTag
import android.content.Context
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PaletteColorsTest {
    @Test
    fun allEightPalettesResolveInBothModesWithReadableTextAndReadProgress() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        fun contrast(a: Color, b: Color): Float =
            (maxOf(a.luminance(), b.luminance()) + 0.05f) /
                (minOf(a.luminance(), b.luminance()) + 0.05f)
        for (dark in listOf(false, true)) {
            val primaries =
                UserPreferencesColorTheme.entries.map { palette ->
                    val resolved = resolvePalette(context, dark, palette)
                    val colors = resolved.scheme
                    assertTrue(
                        "$palette/$dark background",
                        contrast(colors.onBackground, colors.background) >= 4.5f,
                    )
                    assertTrue(
                        "$palette/$dark card",
                        contrast(colors.onSurface, colors.surface) >= 4.5f,
                    )
                    assertTrue(
                        "$palette/$dark dialog actions",
                        contrast(colors.onSurface, colors.surfaceContainerHigh) >= 4.5f,
                    )
                    assertTrue(
                        "$palette/$dark selection",
                        contrast(colors.onSurface, resolved.selection) >= 4.5f,
                    )
                    val status = activityStatusColor(palette, dark)
                    assertTrue(
                        "$palette/$dark page refresh indicator",
                        contrast(status, contentReadTrackColor(status, colors.background)) >= 3f,
                    )
                    assertTrue(
                        "$palette/$dark panel refresh indicator",
                        contrast(status, contentReadTrackColor(status, colors.surface)) >= 3f,
                    )
                    assertEquals(dark, colors.background.luminance() < 0.5f)
                    colors.primary
                }
            assertEquals(8, primaries.toSet().size)
        }
    }

    @Test
    fun defaultReadProgressUsesTheSpecifiedPageAndPanelColors() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val palette = UserPreferencesColorTheme.DEFAULT
        val light = resolvePalette(context, false, palette).scheme
        val dark = resolvePalette(context, true, palette).scheme
        val lightActive = activityStatusColor(palette, dark = false)
        val darkActive = activityStatusColor(palette, dark = true)
        assertEquals(Color(0xFFB5790C), lightActive)
        assertEquals(Color(0xFFFFA500), darkActive)
        assertEquals(Color(0xFFF6EFE2), contentReadTrackColor(lightActive, light.background))
        assertEquals(Color(0xFFF6EFE2), contentReadTrackColor(lightActive, light.surface))
        assertEquals(Color(0xFF3E331D), contentReadTrackColor(darkActive, dark.background))
        assertEquals(Color(0xFF453A25), contentReadTrackColor(darkActive, dark.surface))
    }

    @Test
    fun generatedLocaleNamesPreserveChineseScriptsAndCanonicalLanguageTags() {
        assertEquals("zh-Hans", UserPreferencesLocale.ZH_HANS.languageTag())
        assertEquals("zh-Hant", UserPreferencesLocale.ZH_HANT.languageTag())
        assertEquals("pt-BR", UserPreferencesLocale.PT_BR.languageTag())
        assertEquals("id-ID", UserPreferencesLocale.ID_ID.languageTag())
    }
}
