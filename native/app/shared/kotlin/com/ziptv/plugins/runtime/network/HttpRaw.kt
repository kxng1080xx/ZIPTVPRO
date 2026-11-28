package com.ziptv.plugins.runtime.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** A plugin's fetch() result (Nuvio's RawHttpResponse). */
internal class RawHttpResponse(
    val status: Int,
    val statusText: String,
    val url: String,
    val body: String,
    val headers: Map<String, String>,
    val bodyBytes: ByteArray,
)

private const val MAX_BODY_BYTES = 1024 * 1024 // Nuvio's limit for plugin responses

private val client by lazy {
    OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).callTimeout(45, TimeUnit.SECONDS).build()
}
private val noRedirects by lazy { client.newBuilder().followRedirects(false).followSslRedirects(false).build() }

/** fetch() for plugins, over OkHttp (Nuvio's httpRequestRaw contract: body capped at 1 MB, lower-case headers). */
internal suspend fun httpRequestRaw(
    method: String,
    url: String,
    headers: Map<String, String>,
    body: String,
    followRedirects: Boolean = true,
    bodyBytes: ByteArray? = null,
): RawHttpResponse = withContext(Dispatchers.IO) {
    val m = method.trim().uppercase().ifBlank { "GET" }
    val contentType = headers.entries.firstOrNull { it.key.equals("Content-Type", true) }?.value
    val payload = (bodyBytes ?: body.encodeToByteArray()).toRequestBody(contentType?.toMediaTypeOrNull())
    val req = Request.Builder().url(url).apply {
        // OkHttp handles gzip itself, and only if it asked for it.
        headers.forEach { (k, v) -> if (k.isNotBlank() && !k.equals("Accept-Encoding", true)) header(k, v) }
        method(m, if (m == "GET" || m == "HEAD") null else payload)
    }.build()
    (if (followRedirects) client else noRedirects).newCall(req).execute().use { r ->
        val bytes = r.body?.byteStream()?.use { s -> s.readUpTo(MAX_BODY_BYTES) } ?: ByteArray(0)
        val charset = r.body?.contentType()?.charset() ?: Charsets.UTF_8
        RawHttpResponse(r.code, r.message, r.request.url.toString(), String(bytes, charset),
            r.headers.toMultimap().map { (k, v) -> k.lowercase() to v.joinToString(",") }.toMap(), bytes)
    }
}

/** InputStream.readNBytes is Android 13+ only (Fire TV sticks run 7.1). */
private fun java.io.InputStream.readUpTo(max: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(8192)
    while (out.size() < max) {
        val n = read(buf, 0, minOf(buf.size, max - out.size()))
        if (n < 0) break
        out.write(buf, 0, n)
    }
    return out.toByteArray()
}
