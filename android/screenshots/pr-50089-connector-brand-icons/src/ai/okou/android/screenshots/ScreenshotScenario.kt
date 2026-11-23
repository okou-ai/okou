package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.ChatListApiFixture
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import androidx.appcompat.app.AppCompatDelegate
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun phoneDirectoryDetailAndChangedArtwork() =
        onDevice("phone", 412, 892) { fixture ->
            awaitArtwork(rowTile("Google Calendar"), 20, ::saturated)
            awaitArtwork(rowTile("Gmail"), 20, ::saturated)
            awaitArtwork(rowTile("Slack"), 20, ::saturated, minimum = 100)
            ScreenshotCapture.capture("phone-discover.png")

            val calendarIcon = designIcons.getValue(CONNECTOR_CALENDAR).asset
            assertEquals(1, fixture.iconRequests.count { it == calendarIcon })
            text("Google Calendar").click()
            text("添加账号")
            awaitArtwork(detailTile("Google Calendar"), 24, ::saturated)
            assertEquals(1, fixture.iconRequests.count { it == calendarIcon })
            ScreenshotCapture.capture("phone-calendar.png")

            description("返回").click()
            category("文档与文件")
            text("Google Drive").click()
            text("连接账号")
            assertTrue(await { "google-drive" in fixture.iconRequests })
            awaitEmptyTile(detailTile("Google Drive"))
            ScreenshotCapture.capture("phone-missing-icon.png")

            fixture.icons = fixture.icons + ("google-drive" to designIcons.getValue("google-drive"))
            description("返回").click()
            text("Google Drive").click()
            text("连接账号")
            awaitArtwork(detailTile("Google Drive"), 24, ::driveGreen)
            assertTrue("google-drive-v219" in fixture.iconRequests)
            ScreenshotCapture.capture("phone-updated-icon.png")
        }

    @Test
    fun wideArtworkKeepsColorsAndCacheAcrossAppearance() =
        onDevice("wide", 1180, 820) { fixture ->
            text("Google Calendar").click()
            text("添加账号")
            awaitArtwork(rowTile("Slack"), 20, ::saturated, minimum = 100)
            awaitArtwork(detailTile("Google Calendar", wide = true), 24, ::saturated)
            ScreenshotCapture.capture("wide-light.png")

            category("开发者工具")
            awaitArtwork(rowTile("GitHub"), 20, ::black)
            text("GitHub").click()
            text("连接账号")
            awaitArtwork(detailTile("GitHub", wide = true), 24, ::black)
            val githubRequests = fixture.iconRequests.count { it == "github-v219" }
            assertEquals(1, githubRequests)
            device.executeShellCommand("cmd uimode night yes")
            assertTrue(
                await {
                    app.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
                        Configuration.UI_MODE_NIGHT_YES
                }
            )
            awaitArtwork(rowTile("GitHub"), 20, ::white)
            awaitArtwork(detailTile("GitHub", wide = true), 24, ::white)
            assertEquals(githubRequests, fixture.iconRequests.count { it == "github-v219" })
            category("不限类别")
            awaitArtwork(rowTile("Slack"), 20, ::slackPink, minimum = 6)
            ScreenshotCapture.capture("wide-dark.png")
        }

    @Test
    fun connectedServiceOutsideDiscoveryKeepsItsScaledArtwork() =
        onDevice("connected", 1180, 820, omitted = setOf("slack")) { fixture ->
            text("Google Calendar")
            assertTrue(device.findObjects(By.text("Slack")).isEmpty())
            text("已连接").click()
            awaitArtwork(rowTile("Slack"), 20, ::saturated, minimum = 100)
            text("Slack").click()
            text("示例团队")
            awaitArtwork(detailTile("Slack", wide = true), 24, ::saturated, minimum = 100)
            assertEquals(1, fixture.iconRequests.count { it == "slack-v219" })
            ScreenshotCapture.capture("wide-connected.png")
        }

    private class Controls(val app: TestOkouApplication, val device: UiDevice) {
        fun text(label: String): UiObject2 = find(By.pkg(app.packageName).text(label), label)

        fun description(label: String): UiObject2 = find(By.pkg(app.packageName).desc(label), label)

        private fun find(selector: BySelector, label: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                "Missing visible control: $label"
            }

        fun category(label: String) {
            description("筛选服务类别").click()
            val text = text(label)
            checkNotNull(generateSequence(text) { it.parent }.firstOrNull { it.isClickable })
                .click()
        }

        fun rowTile(label: String): Rect {
            val row =
                checkNotNull(
                        generateSequence(text(label)) { it.parent }.firstOrNull { it.isClickable }
                    )
                    .visibleBounds
            assertTrue("Connector row touch height", row.height() >= 80)
            return Rect(row.left + 12, row.top + 8, row.left + 52, row.top + 48)
        }

        fun detailTile(label: String, wide: Boolean = false): Rect {
            val title =
                checkNotNull(
                    device.wait(
                        object : Condition<UiDevice, Rect?> {
                            override fun apply(device: UiDevice): Rect? =
                                device
                                    .findObjects(By.pkg(app.packageName).text(label))
                                    .firstNotNullOfOrNull { node ->
                                        try {
                                            node.visibleBounds.takeIf { !wide || it.left > 344 }
                                        } catch (_: StaleObjectException) {
                                            null
                                        }
                                    }
                        },
                        12_000,
                    )
                ) {
                    "Missing detail heading: $label"
                }
            return Rect(title.left - 60, title.top, title.left - 12, title.top + 48)
        }

        fun awaitArtwork(tile: Rect, markSize: Int, color: (Int) -> Boolean, minimum: Int = 25) {
            val mark =
                Rect(tile).apply {
                    inset((tile.width() - markSize) / 2, (tile.height() - markSize) / 2)
                }
            assertTrue(
                "Expected visible $markSize dp artwork in $mark",
                await {
                    withPixels {
                        val inside = countPixels(it, mark, color)
                        val outside = countPixels(it, tile, color) - inside
                        inside >= minimum && outside == 0
                    }
                },
            )
        }

        fun awaitEmptyTile(tile: Rect) {
            val mark = Rect(tile).apply { inset(12, 12) }
            assertTrue(
                "Missing artwork should leave an empty tile",
                await {
                    withPixels { bitmap ->
                        val center = bitmap.getPixel(tile.centerX(), tile.centerY())
                        val page = bitmap.getPixel(tile.left - 2, tile.centerY())
                        center != page &&
                            countPixels(bitmap, mark) { it == center } ==
                                mark.width() * mark.height()
                    }
                },
            )
        }

        fun await(predicate: () -> Boolean): Boolean =
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean = predicate()
                },
                12_000,
            )
    }

    private fun onDevice(
        scenario: String,
        width: Int,
        height: Int,
        omitted: Set<String> = emptySet(),
        exercise: Controls.(ConnectorApiFixture) -> Unit,
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val savedConnectors = app.connectorService
        val savedChats = app.chatService
        val savedConnectivity = app.connectivity.value
        val preferences = app.snapshotApiPreferences()
        val locales = AppCompatDelegate.getApplicationLocales()
        val auth = app.authentication as TestAuthentication
        val savedAuth = auth.state.value
        val size = deviceOverride("size", device.executeShellCommand("wm size"))
        val density = deviceOverride("density", device.executeShellCommand("wm density"))
        val fontScale = device.executeShellCommand("settings get system font_scale").trim()
        val night =
            device.executeShellCommand("cmd uimode night").substringAfter("Night mode:").trim()
        val controls = Controls(app, device)

        ChatListApiFixture().use { chats ->
            ConnectorApiFixture().use { fixture ->
                fixture.icons = designIcons - "google-drive"
                fixture.omittedFromDefaultBrowse = omitted
                try {
                    device.executeShellCommand("wm size ${width}x$height")
                    device.executeShellCommand("wm density 160")
                    device.executeShellCommand("settings put system font_scale 1.0")
                    device.executeShellCommand("cmd uimode night no")
                    app.connectorService = fixture.service
                    app.chatService = chats.service
                    app.connectivity.value = true
                    val user = "connector-artwork-${UUID.randomUUID()}"
                    app.restoreApiPreferences(
                        preferences +
                            (Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                                testPreferences()
                                    .copy(
                                        locale = UserPreferencesLocale.ZH_HANS,
                                        theme = UserPreferencesTheme.SYSTEM,
                                    ))
                    )
                    auth.state.value = testAuthenticationState(user = user)
                    ActivityScenario.launch(MainActivity::class.java).use {
                        try {
                            with(controls) {
                                assertTrue(
                                    await {
                                        device.displayWidth == width &&
                                            device.displayHeight == height &&
                                            app.resources.configuration.densityDpi == 160 &&
                                            app.resources.configuration.fontScale == 1f
                                    }
                                )
                                description("连接器").click()
                                description("筛选服务类别")
                                exercise(fixture)
                            }
                        } catch (error: Throwable) {
                            try {
                                ScreenshotCapture.capture("failure-$scenario.png")
                                TestStorage()
                                    .openOutputFile("failure-$scenario-window.xml")
                                    .use(device::dumpWindowHierarchy)
                            } catch (diagnostic: Throwable) {
                                error.addSuppressed(diagnostic)
                            }
                            throw error
                        }
                    }
                } finally {
                    app.connectorService = savedConnectors
                    app.chatService = savedChats
                    app.connectivity.value = savedConnectivity
                    app.restoreApiPreferences(preferences)
                    auth.state.value = savedAuth
                    instrumentation.runOnMainSync {
                        AppCompatDelegate.setApplicationLocales(locales)
                    }
                    device.executeShellCommand("wm size ${size ?: "reset"}")
                    device.executeShellCommand("wm density ${density ?: "reset"}")
                    if (fontScale == "null")
                        device.executeShellCommand("settings delete system font_scale")
                    else device.executeShellCommand("settings put system font_scale $fontScale")
                    if (night in setOf("auto", "yes", "no", "custom")) {
                        device.executeShellCommand("cmd uimode night $night")
                    }
                }
            }
        }
    }

    private fun deviceOverride(kind: String, output: String): String? =
        Regex("Override $kind: ([0-9x]+)").find(output)?.groupValues?.get(1)
}

private fun withPixels(check: (Bitmap) -> Boolean): Boolean {
    val bitmap = takeScreenshot()
    try {
        return check(bitmap)
    } finally {
        bitmap.recycle()
    }
}

private fun countPixels(bitmap: Bitmap, region: Rect, check: (Int) -> Boolean): Int {
    var hits = 0
    for (y in region.top until region.bottom) {
        for (x in region.left until region.right) {
            if (check(bitmap.getPixel(x, y))) hits++
        }
    }
    return hits
}

private fun saturated(pixel: Int): Boolean {
    val r = Color.red(pixel)
    val g = Color.green(pixel)
    val b = Color.blue(pixel)
    return maxOf(r, g, b) - minOf(r, g, b) > 70
}

private fun black(pixel: Int): Boolean =
    maxOf(Color.red(pixel), Color.green(pixel), Color.blue(pixel)) < 45

private fun white(pixel: Int): Boolean =
    minOf(Color.red(pixel), Color.green(pixel), Color.blue(pixel)) > 230

private fun slackPink(pixel: Int): Boolean =
    Color.red(pixel) in 221..227 && Color.green(pixel) in 27..33 && Color.blue(pixel) in 87..93

private fun driveGreen(pixel: Int): Boolean =
    Color.red(pixel) <= 50 && Color.green(pixel) in 165..220 && Color.blue(pixel) in 75..130
