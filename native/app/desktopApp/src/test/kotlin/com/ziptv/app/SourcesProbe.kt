package com.ziptv.app

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertTrue

// Live network check of the built-in sources end to end (Cinemeta -> sources -> LAN proxy). Skipped unless ZIPTV_PROBE=1.
// Run: ZIPTV_PROBE=1 ./gradlew :desktopApp:test --tests '*SourcesProbe*' -i
class SourcesProbe {
    /** ZIPTV_PROBE=1: the anime JS sources in QuickJS (Naruto Shippuden S1E5, TMDB 31910). */
    @Test fun anime() {
        if (System.getenv("ZIPTV_PROBE") != "1") return
        val dir = java.io.File(System.getProperty("java.io.tmpdir"), "ziptv-probe").apply { mkdirs() }
        com.ziptv.plugins.configureDesktopQuickJs(dir)
        com.ziptv.sources.AnimeSources.dir = dir
        val plugins = runBlocking { com.ziptv.sources.AnimeSources.plugins() }
        println("PROBE anime plugins=${plugins.map { it.name }}")
        val direct = runCatching { runBlocking { com.ziptv.plugins.runtime.PluginRuntime.executePlugin(plugins.first().code, "31910", "series", 1, 5, plugins.first().id, false) } }
        println("PROBE direct ${plugins.first().name}: ${direct.map { it.size.toString() + " links" }.getOrElse { it.stackTraceToString().take(1500) }}")
        val links = runBlocking { com.ziptv.sources.Sources.lookup("31910", movie = false, season = 1, episode = 5).result.await() }
        links.forEach { println("PROBE anime ${it.height}p ${it.source} ${it.url.take(70)}") }
        assertTrue(links.any { it.source.contains("MegaPlay") || it.source.contains("Anikoto") || it.source.contains("Anime") || it.source.contains("Kick") },
            "no anime source answered")
    }

    /** ZIPTV_PROBE=1: audio labels + subtitle files on the anime links, and one subtitle file through the proxy. */
    @Test fun animeAudioAndSubs() {
        if (System.getenv("ZIPTV_PROBE") != "1") return
        val dir = java.io.File(System.getProperty("java.io.tmpdir"), "ziptv-probe").apply { mkdirs() }
        com.ziptv.plugins.configureDesktopQuickJs(dir)
        com.ziptv.sources.AnimeSources.dir = dir
        val links = runBlocking { com.ziptv.sources.Sources.lookup("31910", movie = false, season = 1, episode = 2).result.await() }
        links.filter { it.audio != null }.take(4).forEach { println("PROBE audio=${it.audio} source=${it.source} subs=${it.subtitles.map { s -> s.label + "/" + s.lang }}") }
        val sub = links.firstNotNullOfOrNull { l -> l.subtitles.firstOrNull { it.lang == "en" || it.lang == "eng" } } ?: return
        val lan = com.ziptv.core.LanServer(18960.toUShort())
        fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
        val u = "http://127.0.0.1:${lan.port()}/src/play/sub.vtt?u=${enc(sub.url)}&h=${enc(sub.headers.entries.joinToString("\n") { "${it.key}: ${it.value}" })}"
        val c = java.net.URL(u).openConnection() as java.net.HttpURLConnection
        println("PROBE sub via proxy: ${c.responseCode} ${c.contentType} :: ${c.inputStream.bufferedReader().readText().take(120).replace("\n", " | ")}")
    }

    /** ZIPTV_PROBE=1: what each anime plugin returns for Naruto Shippuden S1E1 (audio wording + subtitle files). */
    @Test fun animeRaw() {
        if (System.getenv("ZIPTV_PROBE") != "1") return
        val dir = java.io.File(System.getProperty("java.io.tmpdir"), "ziptv-probe").apply { mkdirs() }
        com.ziptv.plugins.configureDesktopQuickJs(dir)
        com.ziptv.sources.AnimeSources.dir = dir
        runBlocking {
            for (p in com.ziptv.sources.AnimeSources.plugins()) {
                val r = com.ziptv.sources.AnimeSources.run(p, "mal:1735", false, null, 1)
                r.take(4).forEach { println("PROBE raw ${p.name} name=${it.name} title=${it.title} lang=${it.language} q=${it.quality} subs=${it.subtitles?.map { s -> s.language + ":" + s.url.takeLast(30) }}") }
                if (r.isEmpty()) println("PROBE raw ${p.name}: none")
            }
        }
    }

    /** ZIPTV_PROBE=1: intro/recap/credits times (IntroDB for Breaking Bad, AniSkip for Naruto Shippuden). */
    @Test fun skipTimes() {
        if (System.getenv("ZIPTV_PROBE") != "1") return
        runBlocking {
            println("PROBE skip BB S1E2: ${SkipTimes.of("tt0903747", 1, 2)}")
            println("PROBE skip Naruto S1E1: ${SkipTimes.of("tt0988824", 1, 1)}")
            println("PROBE skip Naruto S2E3: ${SkipTimes.of("tt0988824", 2, 3)}")
            println("PROBE skip Inception (movie): ${SkipTimes.of("tt1375666", null, null)}")
        }
    }

    /** ZIPTV_PROBE=1: an anime HLS link through the LAN proxy, playlist -> variant -> first segments. */
    @Test fun animeThroughProxy() {
        if (System.getenv("ZIPTV_PROBE") != "1") return
        val dir = java.io.File(System.getProperty("java.io.tmpdir"), "ziptv-probe").apply { mkdirs() }
        com.ziptv.plugins.configureDesktopQuickJs(dir)
        com.ziptv.sources.AnimeSources.dir = dir
        val links = runBlocking { com.ziptv.sources.Sources.lookup("31910", movie = false, season = 1, episode = 1).result.await() }
        val lan = com.ziptv.core.LanServer(18950.toUShort())
        val base = "http://127.0.0.1:${lan.port()}"
        fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
        fun get(u: String): Triple<Int, String?, ByteArray> {
            val c = java.net.URL(u).openConnection() as java.net.HttpURLConnection
            c.readTimeout = 20_000
            val code = runCatching { c.responseCode }.getOrDefault(-1)
            val body = runCatching { (if (code < 400) c.inputStream else c.errorStream)?.use { it.readBytes() } }.getOrNull() ?: ByteArray(0)
            return Triple(code, c.contentType, body)
        }
        for (l in links.take(3)) {
            println("PROBE link ${l.source} headers=${l.headers} ${l.url.take(90)}")
            var url = "$base/src/play?u=${enc(l.url)}&h=${enc(l.headers.entries.joinToString("\n") { "${it.key}: ${it.value}" })}"
            repeat(2) { // master -> variant
                val (code, ct, body) = get(url)
                val text = String(body)
                println("PROBE   playlist $code $ct ${body.size}B :: ${text.lines().take(8).joinToString(" | ").take(400)}")
                val next = text.lines().firstOrNull { it.isNotBlank() && !it.startsWith("#") } ?: return@repeat
                url = if (next.startsWith("/")) base + next else next
                if (!text.contains("#EXT-X-STREAM-INF")) {
                    // media playlist: fetch its first 3 segments
                    text.lines().filter { it.isNotBlank() && !it.startsWith("#") }.take(3).forEach { s ->
                        val (sc, sct, sb) = get(if (s.startsWith("/")) base + s else s)
                        println("PROBE   segment $sc $sct ${sb.size}B first=${sb.take(4).joinToString(",")}")
                    }
                    return@repeat
                }
            }
        }
    }

    /** ZIPTV_PROBE_TITLE="The Odyssey (2026)": what the details page's 4K check sees for one title. */
    @Test fun oneTitle() {
        val title = System.getenv("ZIPTV_PROBE_TITLE") ?: return
        val id = Extras.tmdbIdByTitle(title, null, series = false)
        println("PROBE title=$title tmdb=$id")
        val links = runBlocking { com.ziptv.sources.Sources.lookup(id ?: return@runBlocking emptyList(), true, null, null).result.await() }
        links.forEach { println("PROBE link ${it.height}p ${it.source} ${it.url.take(70)}") }
        println("PROBE count=${links.size} any4k=${links.any { it.is4k }}")
    }

    @Test fun endToEnd() {
        if (System.getenv("ZIPTV_PROBE") != "1") return
        val eps = Extras.episodes(Extras.extId("tt0988824")) // Naruto Shippuden
        println("PROBE cinemeta episodes=${eps.size} seasons=${eps.map { it.season }.distinct().size} first=${eps.firstOrNull()?.title}")
        assertTrue(eps.size > 400)
        println("PROBE tmdb by title: ${Extras.tmdbIdByTitle("EN - Inception (2010) 4K", null, series = false)}")

        val links = runBlocking { com.ziptv.sources.Sources.lookup("27205", movie = true, season = null, episode = null).result.await() }
        val ranked = com.ziptv.sources.Sources.ranked(links, screen4k = true)
        ranked.forEach { println("PROBE link ${it.height}p ${it.source} headers=${it.headers.keys} ${it.url.take(80)}") }
        assertTrue(ranked.isNotEmpty())

        // First bytes of the best links through the LAN proxy (headers added there).
        val lan = com.ziptv.core.LanServer(18900.toUShort())
        val port = lan.port().toInt()
        fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
        var ok = 0
        for (l in ranked.take(4)) {
            val u = "http://127.0.0.1:$port/src/play?u=${enc(l.url)}&h=${enc(l.headers.entries.joinToString("\n") { "${it.key}: ${it.value}" })}"
            val c = java.net.URL(u).openConnection() as java.net.HttpURLConnection
            c.setRequestProperty("Range", "bytes=0-")
            c.readTimeout = 20_000
            val code = runCatching { c.responseCode }.getOrDefault(-1)
            val head = runCatching { c.inputStream.use { it.readNBytes(16) } }.getOrNull()
            println("PROBE proxy ${l.source} -> $code ${c.contentType} ${head?.size ?: 0} bytes ${head?.let { String(it).take(7).replace("\n", " ") }}")
            if (code in 200..299 && (head?.size ?: 0) > 0) ok++
        }
        assertTrue(ok > 0, "no link streamed through the proxy")
    }
}
