package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.WorkspaceMembership
import ai.okou.android.auth.toWorkspaceMembership
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import com.clerk.api.organizations.Organization
import com.clerk.api.organizations.OrganizationMembership
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.JsonObject
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val auth = app.authentication as TestAuthentication
    private val uploadColor = 0xff5733b5.toInt()

    @Test
    fun workspaceAvatarIsSharedAcrossEntryPointsAndSwitches() {
        val previousSession = auth.state.value
        val previousMemberships = auth.available
        val previousChat = app.chatService
        val previousPrefs = app.snapshotApiPreferences()
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocale = localeManager.applicationLocales
        ChatListApiFixture().use { api ->
            val uploaded =
                membership(
                    "org-a",
                    "Personal workspace",
                    api.server.url("/uploaded-workspace.png").toString(),
                    hasImage = true,
                )
            val generatedUrl = api.server.url("/generated-workspace.png").toString()
            val named = membership("org-b", "🚀 — 蓝湾工作室", generatedUrl)
            val generated = membership("org-c", "workspace-32a9d8f0", generatedUrl)
            val symbols = membership("org-d", "🎉 + ✦", generatedUrl)
            val generatedRequests = AtomicInteger()
            val uploadBytes = uploadedImage()
            api.commandResponse = { request ->
                when (request.path) {
                    "/uploaded-workspace.png" ->
                        MockResponse()
                            .setHeader("Content-Type", "image/png")
                            .setBody(Buffer().write(uploadBytes))
                    "/generated-workspace.png" -> {
                        generatedRequests.incrementAndGet()
                        MockResponse().setResponseCode(404)
                    }
                    else -> null
                }
            }
            try {
                val user = "workspace-avatar-${UUID.randomUUID()}"
                auth.available = listOf(uploaded, named, generated, symbols)
                auth.state.value = testAuthenticationState(user = user, workspace = null)
                app.chatService = api.service
                val light =
                    testPreferences()
                        .copy(
                            locale = UserPreferencesLocale.EN_US,
                            theme = UserPreferencesTheme.LIGHT,
                        )
                app.restoreApiPreferences(
                    mapOf(
                        Triple(BuildConfig.API_ORIGIN, user, uploaded.id) to light,
                        Triple(BuildConfig.API_ORIGIN, user, named.id) to
                            light.copy(theme = UserPreferencesTheme.DARK),
                    ),
                )
                ActivityScenario.launch(MainActivity::class.java).use {
                    val picker = row(uploaded.name)
                    for (workspace in listOf(named, generated, symbols)) row(workspace.name)
                    awaitUpload(picker, inRow = true)
                    ScreenshotCapture.capture("01-picker-light.png")

                    tap(picker)
                    val homeUpload = homeAvatar(uploaded)
                    awaitUpload(homeUpload)
                    ScreenshotCapture.capture("02-home-uploaded-light.png")
                    tap(homeUpload)
                    awaitUpload(row(uploaded.name), inRow = true)
                    val namedChoice = row(named.name)
                    ScreenshotCapture.capture("03-home-chooser-light.png")

                    tap(namedChoice)
                    homeAvatar(named)
                    check(auth.state.value.session?.workspaceId == named.id)
                    ScreenshotCapture.capture("04-home-default-dark.png")
                    openSettings()
                    val namedSettings = row(named.name)
                    ScreenshotCapture.capture("05-settings-default-dark.png")
                    tap(namedSettings)
                    val uploadedChoice = row(uploaded.name)
                    awaitUpload(uploadedChoice, inRow = true)
                    ScreenshotCapture.capture("06-settings-chooser-dark.png")

                    tap(uploadedChoice)
                    awaitUpload(homeAvatar(uploaded))
                    check(auth.state.value.session?.workspaceId == uploaded.id)
                    openSettings()
                    awaitUpload(row(uploaded.name), inRow = true)
                    ScreenshotCapture.capture("07-settings-uploaded-light.png")
                    check(generatedRequests.get() == 0) {
                        "The generated Clerk placeholder was requested"
                    }
                }
            } finally {
                auth.state.value = previousSession
                auth.available = previousMemberships
                app.chatService = previousChat
                app.restoreApiPreferences(previousPrefs)
                localeManager.applicationLocales = previousLocale
            }
        }
    }

    private fun membership(
        id: String,
        name: String,
        imageUrl: String,
        hasImage: Boolean = false,
    ): WorkspaceMembership {
        val emptyMetadata = JsonObject(emptyMap())
        return OrganizationMembership(
                id = "membership-$id",
                publicMetadata = emptyMetadata,
                role = "org:member",
                roleName = "Member",
                organization =
                    Organization(
                        id = id,
                        name = name,
                        slug = null,
                        imageUrl = imageUrl,
                        hasImage = hasImage,
                        maxAllowedMemberships = 10,
                        adminDeleteEnabled = true,
                        createdAt = 0,
                        updatedAt = 0,
                        publicMetadata = emptyMetadata,
                    ),
                createdAt = 0,
                updatedAt = 0,
            )
            .toWorkspaceMembership()
    }

    private fun uploadedImage(): ByteArray {
        val bitmap = Bitmap.createBitmap(224, 112, Bitmap.Config.ARGB_8888)
        try {
            bitmap.eraseColor(0xffecac42.toInt())
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = uploadColor }
            Canvas(bitmap).apply {
                drawRect(56f, 0f, 168f, 112f, paint)
                paint.color = 0xffdeccff.toInt()
                drawCircle(92f, 39f, 17f, paint)
                drawCircle(134f, 75f, 13f, paint)
            }
            return ByteArrayOutputStream()
                .also { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
                .toByteArray()
        } finally {
            bitmap.recycle()
        }
    }

    private fun awaitUpload(node: UiObject2, inRow: Boolean = false) {
        val condition =
            object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean {
                    val bounds = node.visibleBounds
                    val screenshot = takeScreenshot()
                    return try {
                        // Android can expose the row label as a child with its own bounds.
                        val centerX = bounds.centerX()
                        val positions = if (inRow) 0..centerX else centerX..centerX
                        positions.any { screenshot.getPixel(it, bounds.centerY()) == uploadColor }
                    } finally {
                        screenshot.recycle()
                    }
                }
            }
        check(device.wait(condition, 10_000)) {
            "The uploaded image was not rendered beside ${node.text ?: node.contentDescription}"
        }
    }

    private fun openSettings() {
        val selector = By.pkg(app.packageName)
        val title = app.getString(R.string.settings)
        val direct = device.findObject(By.copy(selector).desc(title).enabled(true))
        if (direct != null) {
            tap(direct)
        } else {
            tap(
                await(
                    By.copy(selector).desc(app.getString(R.string.chat_more_actions)).enabled(true),
                ),
            )
            tap(row(title))
        }
    }

    private fun homeAvatar(workspace: WorkspaceMembership): UiObject2 {
        val label = app.getString(R.string.auth_switch_workspace)
        return await(By.pkg(app.packageName).desc("$label, ${workspace.name}").enabled(true))
    }

    private fun row(label: String): UiObject2 =
        await(By.pkg(app.packageName).text(label).enabled(true))

    private fun tap(node: UiObject2) {
        val bounds = node.visibleBounds
        check(!bounds.isEmpty && device.click(bounds.centerX(), bounds.centerY())) {
            "Could not tap ${node.text ?: node.contentDescription} at $bounds"
        }
    }

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }
}
