package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatImageGalleryFixture
import ai.okou.android.ComposerApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.artifacts.ArtifactContent
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chatListRegion
import ai.okou.android.testAuthenticationState
import android.graphics.Rect
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun opensDraftAndOutgoingImagesInTheNativeViewer() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val previousComposer = app.composerService
        val previousJournal = app.journalStore
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val root = Files.createTempDirectory(app.cacheDir.toPath(), "attachment-gallery-").toFile()
        val journal = ComposerJournalStore(app, root)
        val identity = WorkspaceIdentity(BuildConfig.API_ORIGIN, "user-a", "session-a", "org-a")
        val originalSize = Regex("Override size: (\\d+x\\d+)")
            .find(device.executeShellCommand("wm size"))?.groupValues?.get(1)
        val originalDensity = Regex("Override density: (\\d+)")
            .find(device.executeShellCommand("wm density"))?.groupValues?.get(1)
        var seeded = emptyList<String>()
        val releaseUpload = CountDownLatch(1)
        val preparingUpload = CountDownLatch(1)
        val releaseOriginal = CountDownLatch(1)

        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun desc(value: String) = By.pkg(app.packageName).desc(value)
        fun await(selector: BySelector) = checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
            "Missing native node $selector"
        }
        fun until(reason: String, predicate: () -> Boolean) {
            check(device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice) = predicate()
            }, 12_000)) { reason }
        }
        fun page(index: Int) = desc(app.getString(R.string.artifact_image_page_description, index, 2))
        fun viewerBack() = await(desc(app.getString(R.string.back))).visibleBounds
        fun toolbar(): Rect {
            val back = viewerBack()
            return Rect(back.left - 12, back.top - 8, device.displayWidth, back.bottom + 8)
        }
        fun view() = Rect(toolbar().left, toolbar().bottom, device.displayWidth, device.displayHeight)
        fun image(name: String) = desc(name).clazz("android.widget.ImageView")
        val actions = desc(app.getString(R.string.artifact_image_actions))
        fun checkToolbar(index: Int, withActions: Boolean) {
            val bounds = toolbar()
            val count = await(page(index)).visibleBounds
            val back = viewerBack()
            check(back.width() == 48 && back.height() == 48) { "Back target $back" }
            check(abs(count.centerX() - bounds.centerX()) <= 1) { "Page number $count, toolbar $bounds" }
            if (withActions) {
                val end = await(actions).visibleBounds
                check(end.width() == 48 && end.height() == 48 && bounds.right - end.right == 12)
            }
            Log.i("OkouGallery", "toolbar=$bounds pageLabel=$count viewport=${view()}")
        }
        fun swipe(next: Boolean) {
            val bounds = view()
            val inset = bounds.width() / 6
            val left = bounds.left + inset
            val right = bounds.right - inset
            check(device.swipe(if (next) right else left, bounds.centerY(),
                if (next) left else right, bounds.centerY(), 24))
        }

        ComposerApiFixture(simulateHistory = false).use { api ->
            val gallery = ChatImageGalleryFixture(api.chats)
            gallery.install()
            val respond = api.chats.commandResponse
            api.chats.commandResponse = { request ->
                if (request.requestUrl?.encodedPath?.startsWith("/api/uploads/prepare") == true) {
                    preparingUpload.countDown()
                    releaseUpload.await(20, TimeUnit.SECONDS)
                    MockResponse().setResponseCode(400)
                } else respond(request)
            }
            try {
                runBlocking { seeded = gallery.seedDraft(journal, identity, "new:", uploaded = false) }
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("wm size 412x892")
                app.chatService = api.service
                app.composerService = api.service
                app.journalStore = journal
                auth.state.value = testAuthenticationState()
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    fun hasIme(): Boolean {
                        var shown = false
                        scenario.onActivity {
                            shown = ViewCompat.getRootWindowInsets(it.window.decorView)
                                ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                        }
                        return shown
                    }
                    fun editorNode() = instrumentation.uiAutomation.rootInActiveWindow
                        ?.findAccessibilityNodeInfosByText(gallery.draftText)
                        ?.firstOrNull { it.className == "android.widget.EditText" }
                    val editor = By.pkg(app.packageName).clazz("android.widget.EditText")
                    await(chatListRegion(app))
                    await(text(app.getString(R.string.composer_new))).click()
                    until("Draft did not load") { device.findObject(editor)?.text == gallery.draftText }
                    until("Upload was never started") { preparingUpload.count == 0L }
                    await(editor).click()
                    until("Keyboard did not open") { hasIme() }
                    val selection = Bundle().apply {
                        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 6)
                        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, 15)
                    }
                    check(checkNotNull(editorNode()).performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection))
                    await(desc(gallery.second)).click()
                    await(page(2))
                    await(image(gallery.second))
                    until("Image viewer did not hide the keyboard") { !hasIme() }
                    checkToolbar(2, withActions = true)
                    check(gallery.originalReads.isEmpty())
                    ScreenshotCapture.capture("01-draft-image.png")
                    swipe(next = false)
                    await(page(1))
                    check(device.pressBack())
                    until("Returning to the draft did not restore the keyboard") { hasIme() }
                    check(await(editor).text == gallery.draftText)
                    val restored = checkNotNull(editorNode())
                    check(restored.textSelectionStart == 6 && restored.textSelectionEnd == 15)
                    check(device.pressBack())
                    until("Keyboard did not close") { !hasIme() }
                    releaseUpload.countDown()

                    device.executeShellCommand("wm size 760x420")
                    val count = desc(app.getString(R.string.chat_attachment_count, 2))
                    await(count).click()
                    await(desc(gallery.first)).click()
                    await(page(1))
                    await(image(gallery.first))
                    ScreenshotCapture.capture("02-short-draft-image.png")
                    check(device.pressBack())
                    await(text(app.getString(R.string.chat_attachments)))
                    await(desc(gallery.first))
                    check(device.pressBack())
                    device.executeShellCommand("wm size 412x892")
                    await(editor)
                    check(device.pressBack())
                    await(text("Personal chat")).click()
                    await(text(gallery.prompt))
                    until("Message thumbnails did not load") { gallery.imageNames.all { it in gallery.thumbnailReads } }
                    gallery.beforeOriginal = { if (it == gallery.first) releaseOriginal.await(12, TimeUnit.SECONDS) }
                    await(desc(gallery.first)).click()
                    await(page(1))
                    await(image(gallery.first))
                    until("Original read did not start") { gallery.first in gallery.originalReads }
                    check(gallery.second !in gallery.originalReads)
                    checkToolbar(1, withActions = true)
                    releaseOriginal.countDown()
                    until("The original did not finish loading") {
                        var ready = false
                        scenario.onActivity {
                            val preview = ViewModelProvider(it)[SessionModel::class.java]
                                .uiState.value.ready?.chatArtifacts?.state?.value?.preview
                            ready = preview?.content is ArtifactContent.EncodedImage
                        }
                        ready
                    }
                    ScreenshotCapture.capture("03-sent-image.png")

                    gallery.denied = gallery.second
                    swipe(next = true)
                    await(page(2))
                    await(text(app.getString(R.string.artifact_image_unavailable)))
                    checkToolbar(2, withActions = false)
                    check(!device.hasObject(actions))
                    check(!device.hasObject(image(gallery.second)))
                    check(gallery.second !in gallery.originalReads)
                    ScreenshotCapture.capture("04-image-unavailable.png")
                    swipe(next = false)
                    await(page(1))
                    await(image(gallery.first))

                    device.executeShellCommand("wm size 1000x1000")
                    val expand = desc(app.getString(R.string.artifact_image_expand))
                    val collapse = desc(app.getString(R.string.artifact_image_collapse))
                    await(expand)
                    val pane = toolbar()
                    check(pane.left == 320) { "Wide viewer bounds $pane" }
                    check(await(actions).visibleBounds.left - await(expand).visibleBounds.right == 4)
                    checkToolbar(1, withActions = true)
                    ScreenshotCapture.capture("05-wide-image.png")
                    await(expand).click()
                    await(collapse)
                    await(page(1))
                    check(toolbar().left == 0)
                    check(device.pressBack())
                    await(expand)
                    check(toolbar() == pane)
                    check(device.pressBack())
                    await(text(gallery.prompt))
                    await(desc(gallery.first))
                }
            } finally {
                releaseUpload.countDown()
                releaseOriginal.countDown()
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
                device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
                runBlocking { withTimeout(10_000) { journal.close() } }
                seeded.forEach { journal.attachmentDirectory(identity).resolve(it).delete() }
                auth.state.value = previousAuth
                app.chatService = previousChats
                app.composerService = previousComposer
                app.journalStore = previousJournal
                app.restoreApiPreferences(preferences)
                cache.restore()
                check(root.deleteRecursively())
            }
        }
    }
}
