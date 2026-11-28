package com.ziptv.app

import com.ziptv.core.Episode
import kotlin.test.Test
import kotlin.test.assertEquals

/** Provider episodes take IMDb/TMDB's season/episode labels; gaps are filled from IMDb. */
class RelabelTest {
    private fun ep(id: String, s: Int, n: Int, title: String = "") = Episode(id, s.toUInt(), n.toUInt(), title, "", null, "mp4", 0u)
    private fun imdb(vararg sn: Pair<Int, Int>) = sn.map { (s, n) -> ep("ext:tt1:$s:$n", s, n, "S${s}E$n") }
    private fun labels(l: List<Episode>) = l.map { "${it.id}=${it.season}x${it.number}" }

    @Test fun sameLabelsKeepTheirPlaceAndGapsComeFromImdb() {
        val got = Extras.relabel(listOf(ep("a", 1, 1), ep("b", 1, 3)), imdb(1 to 1, 1 to 2, 1 to 3))
        assertEquals(listOf("a=1x1", "ext:tt1:1:2=1x2", "b=1x3"), labels(got))
        assertEquals("S1E2", got[1].title)
    }

    @Test fun seasonNumberThatIsReallyTheAbsoluteEpisode() {
        // The provider's "Season 3, Episode 1..2" = episodes 3 and 4 overall (IMDb: S1E1-2, S2E1-2).
        val got = Extras.relabel(listOf(ep("c", 3, 1), ep("d", 3, 2)), imdb(1 to 1, 1 to 2, 2 to 1, 2 to 2))
        assertEquals(listOf("ext:tt1:1:1=1x1", "ext:tt1:1:2=1x2", "c=2x1", "d=2x2"), labels(got))
    }

    @Test fun otherwiseInOrderAndExtrasStayAtTheEnd() {
        val got = Extras.relabel(listOf(ep("a", 1, 1), ep("b", 1, 2), ep("x", 1, 3)), imdb(1 to 1, 2 to 1))
        assertEquals(listOf("a=1x1", "b=2x1", "x=1x3"), labels(got))
    }
}
