package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.SearchCondition
import androidx.test.uiautomator.Searchable
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.time.Instant
import java.time.ZoneId
import java.util.TimeZone
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun capturesArtifactDatesAcrossDeviceZones() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val oldPreferences = app.initialPreferences
        val oldApiPreferences = app.snapshotApiPreferences()
        val oldTimezone = TimeZone.getDefault().id
        val oldSize = device.executeShellCommand("wm size")
        val oldDensity = device.executeShellCommand("wm density")
        val oldScale = device.executeShellCommand("settings get system font_scale").trim()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val (before, after) = zonesCrossingMidnight()

        ChatListApiFixture().use { api ->
            try {
                setZone(before.id)
                val artifacts = ArtifactApiFixture(api, chinese = true)
                artifacts.install()
                auth.state.value = testAuthenticationState(user = "artifact-dates-${UUID.randomUUID()}")
                app.chatService = api.service
                app.initialPreferences = testPreferences().copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = UserPreferencesTheme.LIGHT,
                    timezone = "Asia/Shanghai",
                )
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                device.executeShellCommand("wm size 412x892")
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    activity.onActivity { assertEquals(412, it.resources.configuration.screenWidthDp) }
                    openCatalog(artifacts)
                    val today = By.text("今天")
                    assertTrue(node(today).visibleBounds.bottom <= node(By.text(artifacts.checklist.title)).visibleBounds.top)
                    ScreenshotCapture.capture("catalog-today-phone.png")
                    val queries = artifacts.catalogQueries.size
                    setZone(after.id)
                    assertTrue(device.wait(Until.gone(today.pkg(app.packageName)), 15_000))
                    val yesterday = node(By.text("昨天"))
                    assertTrue(yesterday.visibleBounds.bottom <= node(By.text(artifacts.checklist.title)).visibleBounds.top)
                    assertEquals(queries, artifacts.catalogQueries.size)
                    ScreenshotCapture.capture("catalog-yesterday-phone.png")
                }
                device.executeShellCommand("wm size 1180x820")
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    activity.onActivity { assertEquals(1180, it.resources.configuration.screenWidthDp) }
                    openCatalog(artifacts)
                    tap(By.text(artifacts.checklist.title))
                    node(By.textStartsWith("文件 · 昨天"))
                    node(By.text("保存文件"))
                    ScreenshotCapture.capture("catalog-preview-yesterday-wide.png")
                }
            } catch (failure: Throwable) {
                runCatching { ScreenshotCapture.capture("diagnostic.png") }
                throw failure
            } finally {
                restoreDisplay("size", oldSize)
                restoreDisplay("density", oldDensity)
                if (oldScale.toFloatOrNull() == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else device.executeShellCommand("settings put system font_scale $oldScale")
                auth.state.value = oldAuth
                app.chatService = oldService
                app.initialPreferences = oldPreferences
                app.restoreApiPreferences(oldApiPreferences)
                cache.restore()
                setZone(oldTimezone)
            }
        }
    }

    private fun zonesCrossingMidnight(): Pair<ZoneId, ZoneId> {
        val now = Instant.now()
        val zones = (-12..14).map { offset ->
            ZoneId.of(
                when {
                    offset < 0 -> "Etc/GMT+${-offset}"
                    offset > 0 -> "Etc/GMT-$offset"
                    else -> "Etc/UTC"
                },
            )
        }
        for (before in zones) {
            val firstDate = now.atZone(before).toLocalDate()
            val created = firstDate.atTime(10, 20).atZone(before).toInstant()
            if (!created.isBefore(now.minusSeconds(120))) continue
            for (after in zones) {
                val secondDate = now.atZone(after).toLocalDate()
                if (created.atZone(after).toLocalDate() == secondDate.minusDays(1)) return before to after
            }
        }
        error("No zone pair crosses local midnight for the catalog fixture")
    }

    private fun setZone(id: String) {
        require(id.matches(Regex("[A-Za-z0-9_/+.-]+")))
        device.executeShellCommand("cmd alarm set-timezone $id")
        val changed = device.wait(object : SearchCondition<Boolean>() {
            override fun apply(searchable: Searchable): Boolean? =
                true.takeIf { TimeZone.getDefault().id == id }
        }, 15_000)
        assertEquals("Device time zone", id, TimeZone.getDefault().id)
        assertTrue(changed == true)
    }

    private fun openCatalog(artifacts: ArtifactApiFixture) {
        node(By.text(artifacts.sourceTitle))
        tap(By.desc("成果"))
        node(By.text(artifacts.checklist.title))
    }

    private fun tap(selector: BySelector) {
        val bounds = node(selector).visibleBounds
        assertTrue(device.click(bounds.centerX(), bounds.centerY()))
    }

    private fun node(selector: BySelector): UiObject2 {
        val scoped = By.copy(selector).pkg(app.packageName)
        return checkNotNull(device.wait(object : SearchCondition<UiObject2>() {
            override fun apply(searchable: Searchable): UiObject2? =
                try {
                    searchable.findObject(scoped)
                } catch (_: StaleObjectException) {
                    null
                }
        }, 15_000)) { "Missing $selector" }
    }

    private fun restoreDisplay(setting: String, previous: String) {
        val value = previous.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
        device.executeShellCommand("wm $setting ${value ?: "reset"}")
    }
}
