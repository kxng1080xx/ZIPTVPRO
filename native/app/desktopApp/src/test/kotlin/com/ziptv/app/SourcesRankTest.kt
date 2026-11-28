package com.ziptv.app

import com.ziptv.sources.SourceLink
import com.ziptv.sources.Sources
import kotlin.test.Test
import kotlin.test.assertEquals

/** Audio language first (Settings > Playback), then quality: 4K first only on 4K screens. */
class SourcesRankTest {
    private fun l(name: String, h: Int, vararg langs: String) = SourceLink("http://x/$name", emptyMap(), h, name, langs = langs.toSet())

    @Test fun languageBeatsQualityAndUnknownSitsBetween() {
        val links = listOf(l("hindi4k", 2160, "hi"), l("unknown1080", 1080), l("english720", 720, "en"), l("english4k", 2160, "en"))
        assertEquals(listOf("english4k", "english720", "unknown1080", "hindi4k"), Sources.ranked(links, screen4k = true, lang = "en").map { it.source })
        assertEquals(listOf("english720", "english4k", "unknown1080", "hindi4k"), Sources.ranked(links, screen4k = false, lang = "en").map { it.source })
        assertEquals("hindi4k", Sources.ranked(links, screen4k = true, lang = "hi").first().source)
    }
}
