package ai.okou.android.api

import java.lang.reflect.Type
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.serializer
import okhttp3.ResponseBody
import retrofit2.Converter
import retrofit2.Retrofit

/** Decode canonical response bodies on Retrofit's IO callback without a full JSON String copy. */
@OptIn(ExperimentalSerializationApi::class)
internal class StreamingJsonConverterFactory(private val json: Json) : Converter.Factory() {
    override fun responseBodyConverter(
        type: Type,
        annotations: Array<Annotation>,
        retrofit: Retrofit,
    ): Converter<ResponseBody, *> {
        val serializer = json.serializersModule.serializer(type)
        return Converter<ResponseBody, Any> { body ->
            body.use { json.decodeFromStream(serializer, it.byteStream()) }
        }
    }
}
