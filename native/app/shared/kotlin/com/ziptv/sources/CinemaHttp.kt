package com.ziptv.sources

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import okhttp3.Dns
import java.net.Inet4Address
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A fully / partially read HTTP answer. [body] holds at most the requested number of bytes. */
class CinemaResponse(val code: Int, val headers: Headers, val body: ByteArray, val finalUrl: String = "") {
    val ok: Boolean get() = code in 200..299
    val text: String get() = String(body, Charsets.UTF_8)
    fun header(name: String): String = headers[name].orEmpty()
}

data class TmdbBrief(val title: String, val year: String, val imdbId: String)

/**
 * Shared HTTP layer for the native scrapers. Uses the app OkHttpClient (same DNS / socket factory /
 * connection pool) minus the interceptors that overwrite User-Agent / Accept-Language and the disk
 * cache, so each scraper controls its own headers. Every call carries its own call timeout.
 */
class CinemaHttp {
    private val client: OkHttpClient = OkHttpClient.Builder()
        .dns(object : Dns { // IPv4 first; inline so desktop shares this file
            override fun lookup(hostname: String) = Dns.SYSTEM.lookup(hostname).sortedBy { if (it is Inet4Address) 0 else 1 }
        })
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    /**
     * Performs a request and reads at most [maxBytes] of the body (then closes the connection, which is
     * what lets 1-byte / 64-byte Range probes avoid downloading multi-GB files). Returns null on any
     * network failure or timeout; coroutine cancellation propagates.
     */
    suspend fun fetch(
        url: String,
        headers: Map<String, String> = emptyMap(),
        method: String = "GET",
        body: String? = null,
        timeoutMs: Long = 10_000,
        maxBytes: Int = 4 * 1024 * 1024
    ): CinemaResponse? {
        return try {
            val builder = Request.Builder().url(url)
            headers.forEach { (k, v) -> builder.header(k, v) }
            if (method == "POST") {
                val ct = headers.entries.firstOrNull { it.key.equals("Content-Type", true) }?.value
                builder.post((body ?: "").toRequestBody(ct?.toMediaTypeOrNull()))
            } else if (method == "HEAD") {
                builder.head()
            } else {
                builder.get()
            }
            val call = client.newCall(builder.build())
            call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
            val response = call.await()
            response.use { r ->
                val bytes = withContext(Dispatchers.IO) {
                    val source = r.body?.source() ?: return@withContext ByteArray(0)
                    val out = java.io.ByteArrayOutputStream()
                    val buf = ByteArray(8192)
                    var total = 0
                    val stream = source.inputStream()
                    while (total < maxBytes) {
                        val n = stream.read(buf, 0, minOf(buf.size, maxBytes - total))
                        if (n < 0) break
                        out.write(buf, 0, n)
                        total += n
                    }
                    out.toByteArray()
                }
                CinemaResponse(r.code, r.headers, bytes, r.request.url.toString())
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { runCatching { cancel() } }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                if (cont.isActive) cont.resume(response) else response.close()
            }
        })
    }

    suspend fun json(
        url: String,
        headers: Map<String, String> = emptyMap(),
        timeoutMs: Long = 10_000
    ): JSONObject? {
        val r = fetch(url, headers, timeoutMs = timeoutMs) ?: return null
        if (!r.ok) return null
        return runCatching { JSONObject(r.text) }.getOrNull()
    }

    // ---- TMDB via the CinemaOS web app proxy (shared + cached for all providers) ----------------

    private data class TmdbEntry(val at: Long, val data: JSONObject?)

    private val tmdbCache = ConcurrentHashMap<String, TmdbEntry>()
    private val tmdbLock = Mutex()

    /** Raw TMDB details JSON (movieData / tvData), cached 10 min; failures are not cached. */
    suspend fun tmdbDetails(type: String, id: String): JSONObject? {
        val key = "$type:$id"
        tmdbCache[key]?.let { if (System.currentTimeMillis() - it.at < 600_000 && it.data != null) return it.data }
        return tmdbLock.withLock {
            tmdbCache[key]?.let { if (System.currentTimeMillis() - it.at < 600_000 && it.data != null) return@withLock it.data }
            val requestId = if (type == "movie") "movieData" else "tvData"
            val ref = "https://cinemaos.tech/" + (if (type == "movie") "movie" else "tv") + "/" + id
            var data: JSONObject? = null
            for (attempt in 0 until 2) {
                data = json(
                    "https://cinemaos.tech/api/tmdb?requestID=$requestId&id=$id&language=en-US",
                    mapOf(
                        "Accept" to "*/*",
                        "Accept-Language" to "en-IN,en;q=0.9",
                        "User-Agent" to SAFARI_UA,
                        "Referer" to ref,
                        "Sec-Fetch-Site" to "same-origin",
                        "Sec-Fetch-Mode" to "cors",
                        "Sec-Fetch-Dest" to "empty"
                    ),
                    timeoutMs = 6_000
                )
                if (data != null) break
            }
            if (data != null) tmdbCache[key] = TmdbEntry(System.currentTimeMillis(), data)
            data
        }
    }

    suspend fun tmdbBrief(type: String, id: String): TmdbBrief {
        val d = tmdbDetails(type, id) ?: return TmdbBrief("", "", "")
        val title = d.str("title") ?: d.str("name") ?: ""
        val date = d.str("release_date") ?: d.str("first_air_date") ?: ""
        val imdb = d.optJSONObject("external_ids")?.str("imdb_id") ?: d.str("imdb_id") ?: ""
        return TmdbBrief(title, date.take(4), imdb)
    }

    // ---- anime detection (arm.haglund.dev), cached --------------------------------------------

    private val animeCache = ConcurrentHashMap<String, Boolean>()

    /** True when ARM maps this TMDB id to an anime entry (those belong to the anime plugins). */
    suspend fun isAnimeTmdb(id: String): Boolean {
        animeCache[id]?.let { return it }
        val r = fetch("https://arm.haglund.dev/api/v2/themoviedb?id=$id", timeoutMs = 4_000, maxBytes = 256 * 1024)
        val v = if (r != null && r.ok) {
            runCatching { JSONArray(r.text).length() > 0 }.getOrDefault(false)
        } else {
            return false // unknown: do not cache
        }
        animeCache[id] = v
        return v
    }

    companion object {
        const val SAFARI_UA =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"

        /** Hosts that failed a probe recently (shared by every scraper). */
        val deadHosts = ConcurrentHashMap<String, Long>()

        fun hostOf(url: String): String = Regex("^https?://([^/]+)", RegexOption.IGNORE_CASE)
            .find(url)?.groupValues?.get(1).orEmpty()
    }

    // ---- shared playability probe for direct MKV / MP4 links (HdHub, Wing) ---------------------

    /**
     * Range head probe (first 64 bytes must look like MKV / MP4 / video content-type, server must answer 206)
     * followed by a tail probe (last 1 MB) because ExoPlayer reads the end of MKV / MP4 (cues / moov).
     * Callers probe many candidates concurrently.
     */
    suspend fun isVideo(url: String, headers: Map<String, String> = emptyMap(), timeoutMs: Long = 7_000): Boolean {
        probeCache[url]?.let { if (System.currentTimeMillis() - it.first < 600_000) return it.second }
        val ok = isVideoUncached(url, headers, timeoutMs)
        if (ok) probeCache[url] = System.currentTimeMillis() to true
        return ok
    }

    private val probeCache = ConcurrentHashMap<String, Pair<Long, Boolean>>()

    /**
     * Fast HEAD probe: false only when the link clearly is not a media file (network failure, 4xx / 5xx other than
     * "HEAD not allowed", or an HTML answer such as a Cloudflare challenge page).
     */
    suspend fun headLooksPlayable(url: String, headers: Map<String, String> = emptyMap(), timeoutMs: Long = 3_000): Boolean {
        val r = fetch(url, headers, method = "HEAD", timeoutMs = timeoutMs, maxBytes = 1) ?: return false
        if (r.code == 405 || r.code == 501) return true
        if (!r.ok) return false
        return !Regex("text/html|application/json", RegexOption.IGNORE_CASE).containsMatchIn(r.header("content-type"))
    }

    private fun u32(b: ByteArray, o: Int): Long =
        ((b[o].toLong() and 0xff) shl 24) or ((b[o + 1].toLong() and 0xff) shl 16) or
            ((b[o + 2].toLong() and 0xff) shl 8) or (b[o + 3].toLong() and 0xff)

    private fun u64(b: ByteArray, o: Int): Long = (u32(b, o) shl 32) or u32(b, o + 4)

    /**
     * Duration in seconds of an MP4 read from its moov / mvhd box with small Range requests (walks top-level boxes,
     * so a moov at the end of the file costs one extra request). Null when it cannot be determined.
     */
    suspend fun mp4DurationSec(url: String, headers: Map<String, String>, timeoutMs: Long = 6_000): Double? {
        var offset = 0L
        var hops = 0
        while (hops++ < 8) {
            val r = fetch(
                url,
                headers + ("Range" to "bytes=$offset-${offset + 4095}"),
                timeoutMs = timeoutMs,
                maxBytes = 4096,
            ) ?: return null
            if (!(r.code == 206 || (r.code == 200 && offset == 0L))) return null
            val b = r.body
            var p = 0
            var refetchAt = -1L
            while (p + 8 <= b.size) {
                var size = u32(b, p)
                val type = String(b, p + 4, 4, Charsets.ISO_8859_1)
                var hdr = 8
                if (size == 1L) {
                    if (p + 16 > b.size) { refetchAt = offset + p; break }
                    size = u64(b, p + 8)
                    hdr = 16
                }
                if (type == "moov") {
                    val q = p + hdr
                    if (q + 40 > b.size) { refetchAt = offset + p; break }
                    if (String(b, q + 4, 4, Charsets.ISO_8859_1) != "mvhd") return null
                    val version = b[q + 8].toInt()
                    val scale: Long
                    val dur: Long
                    if (version == 1) { scale = u32(b, q + 28); dur = u64(b, q + 32) } else { scale = u32(b, q + 20); dur = u32(b, q + 24) }
                    return if (scale > 0) dur.toDouble() / scale else null
                }
                if (size < hdr || size == 0L) return null
                if (p + size < b.size) { p += size.toInt(); continue }
                refetchAt = offset + p + size
                break
            }
            if (refetchAt < 0) return null
            offset = refetchAt
        }
        return null
    }

    /** Same check as the RN app: one 64-byte ranged read; HTML / JSON answers and non-video bodies are dropped. */
    private suspend fun isVideoUncached(url: String, headers: Map<String, String>, timeoutMs: Long): Boolean {
        val h = headers.toMutableMap().also { it["Range"] = "bytes=0-63" }
        val head = fetch(url, h, timeoutMs = timeoutMs, maxBytes = 64) ?: return false
        val ct = head.header("content-type")
        if (!head.ok || Regex("text/html|application/json", RegexOption.IGNORE_CASE).containsMatchIn(ct)) return false
        return looksLikeVideo(head.body, ct)
    }

    private fun looksLikeVideo(b: ByteArray, contentType: String): Boolean {
        val mkv = b.size >= 4 && b[0] == 0x1a.toByte() && b[1] == 0x45.toByte() && b[2] == 0xdf.toByte() && b[3] == 0xa3.toByte()
        val mp4 = b.size >= 8 && b[4] == 0x66.toByte() && b[5] == 0x74.toByte() && b[6] == 0x79.toByte() && b[7] == 0x70.toByte()
        return mkv || mp4 || contentType.startsWith("video/", ignoreCase = true)
    }
}
