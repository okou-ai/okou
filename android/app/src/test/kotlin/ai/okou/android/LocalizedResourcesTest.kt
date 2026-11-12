package ai.okou.android

import android.content.Context
import android.content.res.Configuration
import android.os.LocaleList
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 35])
class LocalizedResourcesTest {
    @Test
    fun nativeLocaleMatchingSupportsEveryLanguageAndChineseScriptFallback() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val cases =
            listOf(
                Triple("en-US", "Settings", "Follow system"),
                Triple("pt-BR", "Configurações", "Seguir o sistema"),
                Triple("ja-JP", "設定", "システム設定に従う"),
                Triple("ko-KR", "설정", "시스템 설정 따르기"),
                Triple("id-ID", "Setelan", "Ikuti sistem"),
                Triple("de-DE", "Einstellungen", "Systemeinstellung"),
                Triple("es-ES", "Ajustes", "Seguir el sistema"),
                Triple("it-IT", "Impostazioni", "Segui il sistema"),
                Triple("fr-FR", "Paramètres", "Suivre le système"),
                Triple("hi-IN", "सेटिंग", "सिस्टम के अनुसार"),
                Triple("zh-CN", "设置", "跟随系统"),
                Triple("zh-TW", "設定", "跟隨系統"),
                Triple("zh-Hans", "设置", "跟随系统"),
                Triple("zh-Hant", "設定", "跟隨系統"),
                Triple("zh-HK", "設定", "跟隨系統"),
                Triple("fr-CA", "Paramètres", "Suivre le système"),
            )
        for ((tag, settings, system) in cases) {
            val configuration =
                Configuration(context.resources.configuration).apply {
                    setLocales(LocaleList.forLanguageTags(tag))
                }
            val resources = context.createConfigurationContext(configuration).resources
            assertEquals(tag, settings, resources.getString(R.string.settings))
            assertEquals(tag, system, resources.getString(R.string.appearance_system))
            assertEquals(tag, "Okou", resources.getString(R.string.app_name))
        }
    }
}
