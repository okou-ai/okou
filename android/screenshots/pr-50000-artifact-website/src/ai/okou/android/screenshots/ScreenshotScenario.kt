package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.BuildConfig
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
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun capturesWebsiteOfflineAndReconnectInTheNativeArtifactPreview() {
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousService = app.chatService
        val previousPreferences = app.snapshotApiPreferences()
        val previousConnectivity = app.connectivity.value
        val chatCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val user = "artifact-preview-${UUID.randomUUID()}"
        val size = device.executeShellCommand("wm size")
        val density = device.executeShellCommand("wm density")
        var failure: Throwable? = null
        ChatListApiFixture().use { api ->
            val firstGrant = CountDownLatch(1)
            val reconnectGrant = CountDownLatch(1)
            val release = CountDownLatch(1)
            try {
                val data = ArtifactApiFixture(api, chinese = true)
                data.install()
                data.beforeSitePreview = {
                    if (data.requestedSiteGrants.size == 1) {
                        firstGrant.countDown()
                    } else {
                        reconnectGrant.countDown()
                        check(release.await(45, TimeUnit.SECONDS)) { "Reconnect grant was not released" }
                    }
                }
                app.chatService = api.service
                app.restoreApiPreferences(
                    previousPreferences +
                        (Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                            testPreferences()
                                .copy(
                                    locale = UserPreferencesLocale.ZH_HANS,
                                    theme = UserPreferencesTheme.LIGHT,
                                ))
                )
                app.connectivity.value = true
                auth.state.value = testAuthenticationState(user = user)
                device.executeShellCommand("wm size 1080x2340")
                device.executeShellCommand("wm density 420")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    node(By.text(data.sourceTitle))
                    node(By.desc("成果").enabled(true)).click()
                    node(includesText(data.site.title)).click()
                    node(includesText(data.sourceTitle))
                    node(includesText("打开网页"))
                    assertTrue("Initial grant request missing", firstGrant.await(12, TimeUnit.SECONDS))

                    app.connectivity.value = false
                    node(By.text("联网后可预览"))
                    val source = includesText("查看来源对话")
                    val title = By.text(data.site.title)
                    val titleBounds = node(title).visibleBounds
                    val sourceBounds = node(source).visibleBounds
                    assertFalse(device.hasObject(By.copy(includesText("打开网页")).pkg(app.packageName)))
                    ScreenshotCapture.capture("artifact-website-offline.png")

                    app.connectivity.value = true
                    assertTrue("Reconnect grant request missing", reconnectGrant.await(12, TimeUnit.SECONDS))
                    node(By.clazz("android.widget.ProgressBar"))
                    assertEquals(titleBounds, node(title).visibleBounds)
                    assertEquals(sourceBounds, node(source).visibleBounds)
                    assertFalse(device.hasObject(By.pkg(app.packageName).text("联网后可预览")))
                    ScreenshotCapture.capture("artifact-website-reconnecting.png")

                    app.connectivity.value = false
                    node(By.text("联网后可预览"))
                    release.countDown()
                    device.executeShellCommand("wm size 1180x820")
                    device.executeShellCommand("wm density 160")
                    val catalog = node(By.desc("搜索成果"))
                    val sourceAction = node(source)
                    node(By.text("联网后可预览"))
                    assertTrue(catalog.visibleBounds.right < sourceAction.visibleBounds.left)
                    scenario.onActivity {
                        assertEquals(160, it.resources.configuration.densityDpi)
                        assertTrue(it.resources.configuration.screenWidthDp >= 1100)
                    }
                    ScreenshotCapture.capture("artifact-website-offline-wide.png")
                }
            } catch (error: Throwable) {
                failure = error
                runCatching { ScreenshotCapture.capture("artifact-website-diagnostic.png") }
                    .exceptionOrNull()
                    ?.let(error::addSuppressed)
                throw error
            } finally {
                release.countDown()
                cleanup(
                    failure,
                    { restoreSetting("size", size) },
                    { restoreSetting("density", density) },
                    { auth.state.value = previousAuth },
                    { app.connectivity.value = previousConnectivity },
                    { app.chatService = previousService },
                    { app.restoreApiPreferences(previousPreferences) },
                    { chatCache.restore() },
                )
            }
        }
    }

    private fun includesText(value: String): BySelector =
        By.text(Pattern.compile("(?s).*" + Pattern.quote(value) + ".*"))

    private fun node(selector: BySelector) =
        checkNotNull(device.wait(Until.findObject(By.copy(selector).pkg(app.packageName)), 12_000)) {
            val visibleText = device.findObjects(By.pkg(app.packageName)).mapNotNull { it.text }
            "Missing artifact preview state: $selector. Visible fixture text: $visibleText"
        }

    private fun restoreSetting(setting: String, receipt: String) {
        val override =
            receipt.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
        device.executeShellCommand("wm $setting ${override ?: "reset"}")
    }

    private fun cleanup(original: Throwable?, vararg steps: () -> Unit) {
        var failure = original
        for (step in steps) {
            try {
                step()
            } catch (error: Throwable) {
                if (failure == null) failure = error else failure.addSuppressed(error)
            }
        }
        if (original == null) failure?.let { throw it }
    }
}
