package ai.okou.android.artifacts

import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

class ArtifactShareFileProvider : FileProvider()

/**
 * The chooser owns each successful grant. Cache cleanup leaves time for the receiver to read it.
 */
internal suspend fun shareArtifactOriginal(
    context: Context,
    model: ArtifactCatalogModel,
    id: String,
    original: ArtifactSave,
): ArtifactSaveResult =
    shareOriginalFile(context, original.filename, original.contentType) { copy ->
        model.prepareOriginalShare(id, original) { copy.outputStream() }
    }

internal suspend fun shareOriginalFile(
    context: Context,
    filename: String,
    contentType: String,
    prepare: suspend (File) -> ArtifactSaveResult,
): ArtifactSaveResult {
    var directory: File? = null
    var handedOff = false
    try {
        val name =
            filename.substringAfterLast('/').substringAfterLast('\\').takeUnless {
                it.isBlank() || it == "." || it == ".."
            } ?: "artifact"
        val extension =
            name.substringAfterLast('.', "").takeIf {
                it.length in 1..16 &&
                    it.all { char -> char in 'a'..'z' || char in 'A'..'Z' || char in '0'..'9' }
            }
        val copy =
            withContext(Dispatchers.IO) {
                val cache = File(context.cacheDir, "artifact-shares")
                check(cache.mkdirs() || cache.isDirectory)
                val cutoff = System.currentTimeMillis() - TimeUnit.DAYS.toMillis(1)
                cache
                    .listFiles()
                    ?.filter { it.lastModified() < cutoff }
                    ?.forEach { it.deleteRecursively() }
                File(cache, UUID.randomUUID().toString()).let {
                    check(it.mkdir())
                    directory = it
                    File(it, if (extension == null) "original" else "original.$extension")
                }
            }
        val result = prepare(copy)
        if (result != ArtifactSaveResult.Saved) return result
        currentCoroutineContext().ensureActive()
        val uri =
            FileProvider.getUriForFile(
                context,
                "${context.packageName}.artifact-shares",
                copy,
                name,
            )
        val mime =
            contentType.substringBefore(';').trim().takeIf { '/' in it }
                ?: "application/octet-stream"
        val send =
            Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData(name, arrayOf(mime), ClipData.Item(uri))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        context.startActivity(Intent.createChooser(send, null))
        handedOff = true
        return ArtifactSaveResult.Saved
    } finally {
        if (!handedOff) {
            withContext(NonCancellable + Dispatchers.IO) { directory?.deleteRecursively() }
        }
    }
}
