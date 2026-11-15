package ai.okou.android.updates

import android.util.AtomicFile
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json

class FileUpdateStore(
    private val directory: File,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) : UpdateStore {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun load(): UpdateRecord? =
        withContext(dispatcher) {
            val file = AtomicFile(File(directory, "state.json"))
            try {
                file.openRead().use { input ->
                    // The discovered release and the active transfer can be different snapshots.
                    val bytes = ByteArray(131_073)
                    var length = 0
                    while (length < bytes.size) {
                        val count = input.read(bytes, length, bytes.size - length)
                        if (count < 0) break
                        length += count
                    }
                    if (length > 131_072) throw IOException("Update state exceeds its limit")
                    json.decodeFromString<UpdateRecord>(bytes.decodeToString(0, length))
                }
            } catch (_: java.io.FileNotFoundException) {
                null
            }
        }

    override suspend fun save(record: UpdateRecord) =
        withContext(dispatcher) {
            if (!directory.isDirectory && !directory.mkdirs())
                throw IOException("Cannot create update directory")
            val file = AtomicFile(File(directory, "state.json"))
            val output = file.startWrite()
            try {
                output.write(json.encodeToString(record).toByteArray())
                file.finishWrite(output)
            } catch (error: Exception) {
                file.failWrite(output)
                throw error
            }
        }
}
