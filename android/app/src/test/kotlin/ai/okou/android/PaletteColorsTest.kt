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
    fun allEightPalettesResolveInBothModesWithReadableSurfaceAndSelectionText() {
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
                    assertEquals(dark, colors.background.luminance() < 0.5f)
                    colors.primary
                }
            assertEquals(8, primaries.toSet().size)
        }
    }

    @Test
    fun generatedLocaleNamesPreserveChineseScriptsAndCanonicalLanguageTags() {
        assertEquals("zh-Hans", UserPreferencesLocale.ZH_HANS.languageTag())
        assertEquals("zh-Hant", UserPreferencesLocale.ZH_HANT.languageTag())
        assertEquals("pt-BR", UserPreferencesLocale.PT_BR.languageTag())
        assertEquals("id-ID", UserPreferencesLocale.ID_ID.languageTag())
    }
}
