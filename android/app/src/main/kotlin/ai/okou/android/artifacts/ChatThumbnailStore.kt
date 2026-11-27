package ai.okou.android.artifacts

import ai.okou.android.auth.scopeHash
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.AtomicFile
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal data class CachedInlineThumbnail(val grant: InlineImageGrant, val bitmap: Bitmap)

/**
 * An app-private cache of decoded, size-specific thumbnails and their confirmed file identities.
 */
internal class ChatThumbnailStore(
    private val root: File,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val maxBytes: Long = 64L * 1024 * 1024,
    private val maxEntries: Int = 512,
) {
    private val lock = Mutex()
    private val evictionScope = CoroutineScope(SupervisorJob() + dispatcher)

    fun open(workspace: String, authorization: String, checkCurrent: () -> Unit) =
        Workspace(root.resolve(scopeHash(listOf(workspace, authorization))), checkCurrent)

    inner class Workspace
    internal constructor(
        private val directory: File,
        private val checkCurrent: () -> Unit,
    ) {
        suspend fun load(request: InlineImageRequest): CachedInlineThumbnail? =
            disk(null) {
                checkCurrent()
                val file = entry(request)
                val thumbnail =
                    DataInputStream(BufferedInputStream(file.openRead())).use { input ->
                        val fileId = input.readUTF()
                        val filename = input.readUTF()
                        val bitmap = BitmapFactory.decodeStream(input)
                        if (fileId.isBlank() || bitmap == null) null
                        else
                            CachedInlineThumbnail(
                                InlineImageGrant(request.source, filename, fileId),
                                bitmap,
                            )
                    }
                checkCurrent()
                if (thumbnail == null) file.delete()
                else file.baseFile.setLastModified(System.currentTimeMillis())
                thumbnail
            }

        suspend fun save(request: InlineImageRequest, grant: InlineImageGrant, bitmap: Bitmap) {
            val fileId = grant.fileId ?: return
            disk(Unit) {
                checkCurrent()
                val file = entry(request)
                val stream = file.startWrite()
                try {
                    val output = DataOutputStream(BufferedOutputStream(stream))
                    output.writeUTF(fileId)
                    output.writeUTF(grant.filename)
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
                        throw IOException("Could not encode chat thumbnail")
                    output.flush()
                    currentCoroutineContext().ensureActive()
                    checkCurrent()
                    file.finishWrite(stream)
                } catch (error: Throwable) {
                    file.failWrite(stream)
                    throw error
                }
                trim()
            }
        }

        fun removeSource(source: String) = evict {
            val sourceKey = scopeHash(listOf(source))
            for (thread in directory.listFiles().orEmpty()) {
                thread.resolve(sourceKey).deleteRecursively()
                removeEmptyParents(thread)
            }
        }

        fun removeThreads(threadIds: Set<String>?) = evict {
            if (threadIds == null) directory.deleteRecursively()
            else {
                for (id in threadIds) threadDirectory(id).deleteRecursively()
                removeEmptyParents(directory)
            }
        }

        private fun entry(request: InlineImageRequest) =
            AtomicFile(
                threadDirectory(request.threadId)
                    .resolve(scopeHash(listOf(request.source)))
                    .resolve("${request.width}.thumb"),
            )

        private fun threadDirectory(id: String) = directory.resolve(scopeHash(listOf(id)))
    }

    private fun evict(remove: () -> Unit) {
        // Queue the eviction before the caller publishes its loss of access. Later reads
        // wait for it even if the Activity that learned of the denial has closed.
        evictionScope.launch(start = CoroutineStart.UNDISPATCHED) { disk(Unit) { remove() } }
    }

    private suspend fun <T> disk(default: T, operation: suspend () -> T): T = lock.withLock {
        withContext(dispatcher) {
            try {
                operation()
            } catch (_: IOException) {
                default
            }
        }
    }

    private fun trim() {
        val files = root.walkTopDown().filter { it.isFile }.toList()
        var bytes = files.sumOf { it.length() }
        var count = files.size
        if (bytes <= maxBytes && count <= maxEntries) return
        for (file in files.sortedBy { it.lastModified() }) {
            if (bytes <= maxBytes && count <= maxEntries) return
            val length = file.length()
            if (file.delete()) {
                bytes -= length
                count--
                file.parentFile?.let(::removeEmptyParents)
            }
        }
    }

    private fun removeEmptyParents(start: File) {
        var parent: File? = start
        while (parent != null && parent != root && parent.delete()) parent = parent.parentFile
    }
}
