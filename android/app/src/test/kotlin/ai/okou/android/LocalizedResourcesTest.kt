package ai.okou.android

import ai.okou.android.chat.WorkDuration
import ai.okou.android.chat.formatWorkDuration
import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
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
            val resources = resourcesFor(tag)
            assertEquals(tag, settings, resources.getString(R.string.settings))
            assertEquals(tag, system, resources.getString(R.string.appearance_system))
            assertEquals(tag, "Okou", resources.getString(R.string.app_name))
        }
    }

    @Test
    fun replyDurationUsesEachLanguagePatternForBothCompoundUnits() {
        val cases =
            listOf(
                Triple("en-US", "1 hr 29 min", "1 min 24 sec"),
                Triple("de-DE", "1 h 29 min", "1 min 24 s"),
                Triple("es-ES", "1 h 29 min", "1 min 24 s"),
                Triple("fr-FR", "1\u00A0h\u00A029\u00A0min", "1\u00A0min\u00A024\u00A0s"),
                Triple("hi-IN", "1 घं॰ 29 मि॰", "1 मि॰ 24 से॰"),
                Triple("id-ID", "1 jam 29 menit", "1 menit 24 detik"),
                Triple("it-IT", "1 h 29 min", "1 min 24 s"),
                Triple("ja-JP", "1時間29分", "1分24秒"),
                Triple("ko-KR", "1시간 29분", "1분 24초"),
                Triple("pt-BR", "1 h 29 min", "1 min 24 s"),
                Triple("zh-Hans", "1 小时 29 分钟", "1 分钟 24 秒"),
                Triple("zh-Hant", "1 小時 29 分鐘", "1 分鐘 24 秒"),
            )
        for ((tag, hoursAndMinutes, minutesAndSeconds) in cases) {
            val resources = resourcesFor(tag)
            assertEquals(
                tag,
                hoursAndMinutes,
                formatWorkDuration(resources, WorkDuration(1, 29, 0)),
            )
            assertEquals(
                tag,
                minutesAndSeconds,
                formatWorkDuration(resources, WorkDuration(0, 1, 24)),
            )
        }
    }

    @Test
    fun replyDurationOmitsZeroTrailingUnitsAndKeepsTheElapsedSuffixAttachedInJapanese() {
        val resources = resourcesFor("ja-JP")
        assertEquals("0秒", formatWorkDuration(resources, WorkDuration(0, 0, 0)))
        assertEquals("46秒", formatWorkDuration(resources, WorkDuration(0, 0, 46)))
        assertEquals("1分", formatWorkDuration(resources, WorkDuration(0, 1, 0)))
        assertEquals("2時間", formatWorkDuration(resources, WorkDuration(2, 0, 0)))
        assertEquals(
            "1分24秒作業中",
            resources.getString(
                R.string.conversation_work_elapsed,
                formatWorkDuration(resources, WorkDuration(0, 1, 24)),
            ),
        )
    }

    @Test
    fun systemCopyPreservesChineseAndFrenchSpacingAfterFormatting() {
        for ((tag, hours) in listOf("zh-Hans" to "小时", "zh-Hant" to "小時")) {
            val resources = resourcesFor(tag)
            assertEquals("< 1 $hours", resources.getString(R.string.connector_access_under_hour))
            assertEquals("2 $hours", resources.getString(R.string.connector_access_hours, 2))
            assertEquals("3 天", resources.getString(R.string.connector_access_days, 3))
        }
        val french = resourcesFor("fr-FR")
        assertEquals("Supprimer la discussion\u202F?", french.getString(R.string.chat_delete_title))
        assertEquals(
            "Marquées comme lues\u00A0: 2. Échecs\u00A0: 3.",
            french.getString(R.string.chat_mark_all_read_partial_failed, 2, 3),
        )
        assertEquals("2\u00A0h", french.getString(R.string.connector_access_hours, 2))
    }

    private fun resourcesFor(tag: String): Resources {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val configuration =
            Configuration(context.resources.configuration).apply {
                setLocales(LocaleList.forLanguageTags(tag))
            }
        return context.createConfigurationContext(configuration).resources
    }
}
