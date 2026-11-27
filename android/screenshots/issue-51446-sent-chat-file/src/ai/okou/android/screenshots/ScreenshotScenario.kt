package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatFilePreviewFixture
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import androidx.appcompat.app.AppCompatDelegate
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun filePreviewOffersApprovedActionsAndReturnsToItsMessage() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val priorService = app.chatService
        val priorPreferences = app.snapshotApiPreferences()
        val priorLocales = AppCompatDelegate.getApplicationLocales()
        val auth = app.authentication as TestAuthentication
        val priorAuthentication = auth.state.value
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        fun overrideValue(setting: String): String? =
            device.executeShellCommand("wm $setting").lineSequence()
                .firstOrNull { it.startsWith("Override") }?.substringAfter(":")?.trim()
        val priorSize = overrideValue("size")
        val priorDensity = overrideValue("density")
        val priorScale = device.executeShellCommand("settings get system font_scale").trim()
        fun item(label: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(By.text(label)), 10_000)) { "Missing $label" }
        fun action(label: String): UiObject2 =
            checkNotNull(generateSequence(item(label)) { it.parent }.firstOrNull { it.isClickable })
        ChatListApiFixture().use { transport ->
            val fixture = ChatFilePreviewFixture(transport)
            fixture.install()
            var failure: Throwable? = null
            try {
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                app.chatService = transport.service
                val user = "chat-file-${UUID.randomUUID()}"
                val preferences = testPreferences().copy(
                    locale = UserPreferencesLocale.EN_US,
                    theme = UserPreferencesTheme.LIGHT,
                )
                app.restoreApiPreferences(priorPreferences + (Triple(BuildConfig.API_ORIGIN, user, "org-a") to preferences))
                auth.state.value = testAuthenticationState(user = user)
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    check(device.displayWidth == 412 && device.displayHeight == 892)
                    check(app.resources.configuration.densityDpi == 160)
                    item("Personal chat").click()
                    item(fixture.prompt)
                    val attachment = action(fixture.filename)
                    check(attachment.visibleBounds.width() in 255..262)
                    ScreenshotCapture.capture("01-sent-file.png")
                    attachment.click()
                    item(fixture.preview)
                    val share = action("Share file")
                    val save = action("Save file")
                    check(share.visibleBounds.height() >= 48 && save.visibleBounds.height() >= 48)
                    ScreenshotCapture.capture("02-file-preview.png")
                    fixture.denied = true
                    share.click()
                    item("Unable to share this file")
                    check(device.wait(Until.gone(By.text("Share file")), 10_000) == true)
                    check(!device.hasObject(By.text("Save file")))
                    item(fixture.preview)
                    ScreenshotCapture.capture("03-access-revoked.png")
                    device.executeShellCommand("input keyevent KEYCODE_BACK")
                    item(fixture.prompt)
                    item(fixture.filename)
                }
            } catch (error: Throwable) {
                failure = error
                runCatching { ScreenshotCapture.capture("diagnostic.png") }.exceptionOrNull()?.let(error::addSuppressed)
                throw error
            } finally {
                val restorations = listOf(
                    runCatching { auth.state.value = priorAuthentication },
                    runCatching {
                        app.chatService = priorService
                        app.restoreApiPreferences(priorPreferences)
                    },
                    runCatching { instrumentation.runOnMainSync { AppCompatDelegate.setApplicationLocales(priorLocales) } },
                    runCatching { device.executeShellCommand("wm size ${priorSize ?: "reset"}") },
                    runCatching { device.executeShellCommand("wm density ${priorDensity ?: "reset"}") },
                    runCatching {
                        device.executeShellCommand(
                            if (priorScale == "null") "settings delete system font_scale"
                            else "settings put system font_scale $priorScale",
                        )
                    },
                    runCatching { cache.restore() },
                ).mapNotNull { it.exceptionOrNull() }
                if (failure == null && restorations.isNotEmpty()) throw restorations.first()
                restorations.forEach { failure?.addSuppressed(it) }
            }
        }
    }
}
