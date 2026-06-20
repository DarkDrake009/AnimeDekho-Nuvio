const cheerio = require('cheerio-without-node-native');

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------
const BASE_URL = 'https://www.rareanimes.mov';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const atob = (input) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let str = String(input).replace(/=+$/, '');
  if (str.length % 4 === 1) throw new Error("'atob' failed: bad encoding");
  let output = '';
  for (
    let bc = 0, bs, buffer, i = 0;
    (buffer = str.charAt(i++));
    ~buffer && ((bs = bc % 4 ? bs * 64 + buffer : buffer), bc++ % 4)
      ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
      : 0
  ) {
    buffer = chars.indexOf(buffer);
  }
  return output;
};

const levenshtein = {
  get: function (s, t) {
    if (s === t) return 0;
    var n = s.length, m = t.length;
    if (n === 0) return m;
    if (m === 0) return n;
    var d = [];
    for (var i = 0; i <= n; i++) { d[i] = []; d[i][0] = i; }
    for (var j = 0; j <= m; j++) d[0][j] = j;
    for (var i = 1; i <= n; i++) {
      for (var j = 1; j <= m; j++) {
        var cost = (s.charAt(i - 1) === t.charAt(j - 1)) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      }
    }
    return d[n][m];
  }
};

function fetchText(url, options) {
  options = options || {};
  return fetch(url, {
    headers: Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Referer': BASE_URL + '/'
    }, options.headers || {})
  })
    .then(function (res) { return res.text(); })
    .catch(function (err) {
      console.log('[RareAnimes] Request failed for ' + url + ': ' + err.message);
      return null;
    });
}

// -----------------------------------------------------------------------------
// TMDB lookup
// -----------------------------------------------------------------------------
function getTmdbDetails(tmdbId, type) {
  var isSeries = type === 'series' || type === 'tv';
  var url = 'https://api.themoviedb.org/3/' + (isSeries ? 'tv' : 'movie') + '/' + tmdbId + '?api_key=' + TMDB_API_KEY;
  return fetch(url)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      return isSeries
        ? { title: data.name, year: data.first_air_date ? parseInt(data.first_air_date.split('-')[0]) : 0 }
        : { title: data.title, year: data.release_date ? parseInt(data.release_date.split('-')[0]) : 0 };
    })
    .catch(function (err) {
      console.log('[RareAnimes] TMDB request failed: ' + err.message);
      return null;
    });
}

// -----------------------------------------------------------------------------
// Search -> matching post page
// Note: rareanimes.mov slugs are NOT pattern-consistent (e.g. "...season-1-
// hindi-dubbed-episodes-download-hd" vs "...season-01-episodes-hindi-dubbed-
// download-hd"), so search + fuzzy match is the only reliable lookup path.
// -----------------------------------------------------------------------------
function searchTitle(name) {
  var searchUrl = BASE_URL + '/?s=' + encodeURIComponent(name);
  return fetchText(searchUrl).then(function (html) {
    if (!html) return [];
    var $ = cheerio.load(html);
    var results = [];

    $('article, .post, .result-item, .search-item').each(function (_i, el) {
      var link = $(el).find('a').first().attr('href');
      var title = $(el).find('h1, h2, h3, .entry-title, .title').first().text().trim();
      if (link && title) {
        results.push({ url: link, title: title });
      }
    });

    // Fallback: WordPress themes sometimes only expose results as bare <a> tags
    if (!results.length) {
      $('a').each(function (_i, el) {
        var href = $(el).attr('href') || '';
        var text = $(el).text().trim();
        if (href.indexOf(BASE_URL) === 0 && text.length > 5 && /season|episode|movie/i.test(href)) {
          results.push({ url: href, title: text });
        }
      });
    }

    return results;
  });
}

// Pick the best-matching season/post page for a given title, season number,
// and (for series) preferring slugs that mention the requested season.
function findBestPage(name, season) {
  return searchTitle(name).then(function (results) {
    if (!results.length) return null;

    var scored = results.map(function (r) {
      var cleanTitle = r.title.replace(/Hindi Dubbed|Episodes|Download|HD|FHD/gi, '').trim();
      var dist = levenshtein.get(cleanTitle.toLowerCase(), name.toLowerCase());

      // Bonus: prefer entries whose URL/title mentions the right season number
      if (season) {
        var seasonRegex = new RegExp('season[-\\s]?0*' + season + '(?!\\d)', 'i');
        if (!seasonRegex.test(r.url) && !seasonRegex.test(r.title)) {
          dist += 3; // soft penalty, not exclusion, since some shows are single-page
        }
      }
      return { r: r, dist: dist };
    });

    scored.sort(function (a, b) { return a.dist - b.dist; });
    var best = scored[0];

    if (best && best.dist < 8) {
      return best.r.url.indexOf('http') === 0 ? best.r.url : BASE_URL + best.r.url;
    }
    return null;
  });
}

// -----------------------------------------------------------------------------
// Extract playable/downloadable links from a season/movie post page
//
// NOTE: This theme shows a "press Back if a popup ad opens" warning, which
// suggests the real player iframe / download links ARE present in the page
// HTML (popup ads fire as a separate JS event on click, not a content gate).
// Selectors below are best-effort based on common WP movie-theme markup
// (episode tables/lists with quality-tagged download buttons + embedded
// iframes). Verify against the live page and adjust if structure differs.
// -----------------------------------------------------------------------------
function extractStreamsFromPage(pageUrl, episode) {
  return fetchText(pageUrl).then(function (html) {
    if (!html) return [];
    var $ = cheerio.load(html);
    var streams = [];

    // 1) Direct iframe embeds
    $('iframe').each(function (_i, el) {
      var src = $(el).attr('src') || $(el).attr('data-src');
      if (src && src.indexOf('youtube') === -1 && src.indexOf('vimeo') === -1) {
        streams.push({
          name: 'RareAnimes - Embed',
          title: 'Embedded Player',
          url: src.indexOf('http') === 0 ? src : 'https:' + src,
          behaviorHints: { bingeGroup: 'rareanimes-embed' }
        });
      }
    });

    // 2) Episode/quality download buttons. For series, restrict to rows/blocks
    // that mention the requested episode number when that context exists.
    $('a').each(function (_i, el) {
      var href = $(el).attr('href');
      var text = $(el).text().trim();
      if (!href) return;

      var qualityMatch = text.match(/(\d{3,4}p)/i);
      var looksLikeHost = /hubcloud|hubdrive|gdflix|gdtot|filepress|drive\.google|streamtape|fsl|pixeldrain/i.test(href);
      if (!looksLikeHost) return;

      if (episode) {
        // Try to find an episode marker near this link (parent row/li text)
        var context = $(el).closest('tr, li, .episode-item, p').text();
        var epMatch = context.match(/(?:episode|ep)\s*0*(\d+)/i);
        if (epMatch && parseInt(epMatch[1]) !== parseInt(episode)) {
          return; // skip links belonging to a different episode
        }
      }

      streams.push({
        name: 'RareAnimes - Download' + (qualityMatch ? ' ' + qualityMatch[1] : ''),
        title: text || 'Download Link',
        url: href,
        quality: qualityMatch ? qualityMatch[1] : undefined,
        behaviorHints: { bingeGroup: 'rareanimes-download' }
      });
    });

    // 3) Fallback: obfuscated atob() blob, same pattern as 4khdhub/animedekho
    var scriptBlobMatch = html.match(/atob\(['"]([A-Za-z0-9+/=]{20,})['"]\)/);
    if (scriptBlobMatch) {
      try {
        var decoded = atob(scriptBlobMatch[1]);
        if (decoded.indexOf('http') === 0) {
          streams.push({
            name: 'RareAnimes - Decoded',
            title: 'Decoded Link',
            url: decoded,
            behaviorHints: { bingeGroup: 'rareanimes-decoded' }
          });
        }
      } catch (e) {
        console.log('[RareAnimes] Decode attempt failed: ' + e.message);
      }
    }

    return streams;
  });
}

// -----------------------------------------------------------------------------
// Main entry point
// -----------------------------------------------------------------------------
function getStreams(tmdbId, type, season, episode) {
  return getTmdbDetails(tmdbId, type).then(function (tmdbDetails) {
    if (!tmdbDetails) return [];

    var title = tmdbDetails.title;
    var isSeries = type === 'series' || type === 'tv';

    console.log('[RareAnimes] Search: ' + title + (isSeries ? ' S' + season : ''));

    return findBestPage(title, isSeries ? season : null).then(function (pageUrl) {
      if (!pageUrl) {
        console.log('[RareAnimes] Title page not found');
        return [];
      }
      console.log('[RareAnimes] Found page: ' + pageUrl);

      return extractStreamsFromPage(pageUrl, isSeries ? episode : null);
    });
  }).catch(function (err) {
    console.log('[RareAnimes] getStreams error: ' + err.message);
    return [];
  });
}

// Export for React Native / Nuvio compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
