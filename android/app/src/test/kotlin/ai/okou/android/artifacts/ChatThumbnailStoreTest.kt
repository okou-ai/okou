package ai.okou.android.artifacts

import android.graphics.Bitmap
import android.graphics.Color
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatThumbnailStoreTest {
    @get:Rule val temporary = TemporaryFolder()
    private val source = "/artifacts/lessons001.png"
    private val request = InlineImageRequest("launch-thread", source, 240)
    private val grant = InlineImageGrant(source, "Rollout chart.png", "file-a")

    @Test
    fun reloadsTheConfirmedImageForTheSameScopeFromAReopenedStore() = runBlocking {
        val root = temporary.newFolder()
        val bitmap = solidBitmap()
        var active = true
        val first =
            ChatThumbnailStore(root).open("workspace-a", "member") {
                if (!active) throw CancellationException("Workspace retired")
            }
        first.save(request, grant, bitmap)
        active = false
        assertThrows(CancellationException::class.java) { runBlocking { first.load(request) } }

        val reopened = ChatThumbnailStore(root)
        val cached = checkNotNull(reopened.open("workspace-a", "member") {}.load(request))
        assertEquals(grant, cached.grant)
        assertEquals(Color.CYAN, cached.bitmap.getPixel(0, 0))
        assertNull(reopened.open("workspace-b", "member") {}.load(request))
        assertNull(reopened.open("workspace-a", "different permissions") {}.load(request))
        assertNull(reopened.open("workspace-a", "member") {}.load(request.copy(width = 144)))
    }

    @Test
    fun removesAllSizesOfARevokedSourceAndKeepsOtherImages() = runBlocking {
        val workspace = ChatThumbnailStore(temporary.newFolder()).open("workspace-a", "member") {}
        val bitmap = solidBitmap()
        val small = request.copy(width = 144)
        val otherThread = request.copy(threadId = "other-thread")
        val otherSource = request.copy(source = "/artifacts/diagram222.png")
        for (input in listOf(request, small, otherThread)) workspace.save(input, grant, bitmap)
        workspace.save(otherSource, grant.copy(previewId = otherSource.source), bitmap)

        workspace.removeSource(source)
        for (input in listOf(request, small, otherThread)) assertNull(workspace.load(input))
        assertEquals(Color.CYAN, checkNotNull(workspace.load(otherSource)).bitmap.getPixel(0, 0))
        workspace.removeThreads(setOf(otherSource.threadId))
        assertNull(workspace.load(otherSource))
    }

    @Test
    fun boundsOnDiskEntriesAcrossWorkspaces() = runBlocking {
        val root = temporary.newFolder()
        val store = ChatThumbnailStore(root, maxEntries = 2)
        val bitmap = solidBitmap()
        for (workspace in listOf("primary", "secondary", "tertiary")) {
            store.open(workspace, "member") {}.save(request, grant, bitmap)
        }
        assertEquals(2, root.walkTopDown().count { it.isFile })
    }

    private fun solidBitmap() =
        Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.CYAN) }
}
