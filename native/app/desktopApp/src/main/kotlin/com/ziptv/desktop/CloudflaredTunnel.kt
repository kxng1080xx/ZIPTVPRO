package com.ziptv.desktop

import com.ziptv.app.ShareTunnel
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File
import java.net.URI

/**
 * Cloudflare Quick Tunnel (v9's tunnel-manager.cjs): `cloudflared tunnel --url` publishes the LAN
 * server on a random https://….trycloudflare.com address. No account or domain needed. The core's
 * share token keeps strangers out (LanServer.guard); traffic rides this PC's own upload.
 *
 * cloudflared (~60 MB) is downloaded on first use instead of growing every installer.
 */
class CloudflaredTunnel(private val dir: File) : ShareTunnel {
    override val url = MutableStateFlow<String?>(null)
    override val note = MutableStateFlow<String?>(null)
    @Volatile private var want = false
    @Volatile private var proc: Process? = null

    init {
        Runtime.getRuntime().addShutdownHook(Thread { want = false; proc?.destroy() })
    }

    override fun start(port: Int) {
        if (want || port == 0) return
        want = true
        note.value = null
        url.value = ""
        Thread({ run(port) }, "cloudflared").apply { isDaemon = true }.start()
    }

    override fun stop() {
        want = false
        proc?.destroy()
        url.value = null
        note.value = null
    }

    private fun run(port: Int) {
        val exe = runCatching { binary() }.getOrElse {
            want = false; url.value = null
            note.value = "Couldn't download the tunnel program. Check the internet connection and try again."
            return
        }
        var delay = 1_000L
        while (want) {
            val p = runCatching {
                ProcessBuilder(exe.path, "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$port")
                    .redirectErrorStream(true).start() // Java starts it with CREATE_NO_WINDOW: no console pops up
            }.getOrElse { note.value = "Couldn't start the tunnel: ${it.message}"; break }
            proc = p
            if (!want) { p.destroy(); break }
            // cloudflared prints the assigned address in its log; api.trycloudflare.com is its control endpoint.
            p.inputStream.bufferedReader().forEachLine { line ->
                if (url.value.isNullOrEmpty()) QUICK.find(line)?.let { url.value = it.value; note.value = null; delay = 1_000L }
            }
            p.waitFor()
            proc = null
            if (!want) break
            url.value = ""
            note.value = "Reconnecting…"
            Thread.sleep(delay)
            delay = (delay * 2).coerceAtMost(30_000L)
        }
        if (!want) url.value = null
    }

    private fun binary(): File {
        val exe = File(dir, "cloudflared.exe")
        if (exe.length() > 1_000_000) return exe
        dir.mkdirs()
        note.value = "Downloading the tunnel program (one time, about 60 MB)…"
        val part = File(dir, "cloudflared.exe.part")
        URI(DOWNLOAD).toURL().openStream().use { input -> part.outputStream().use { input.copyTo(it) } }
        check(part.length() > 1_000_000) { "download too small" }
        exe.delete()
        check(part.renameTo(exe)) { "couldn't save cloudflared.exe" }
        note.value = null
        return exe
    }

    private companion object {
        const val DOWNLOAD = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
        val QUICK = Regex("""https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com""")
    }
}
