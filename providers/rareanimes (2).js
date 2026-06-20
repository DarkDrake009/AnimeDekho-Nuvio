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
// Search -> matching post page (slugs are not pattern-consistent on this site)
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
      if (link && title) results.push({ url: link, title: title });
    });

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

function findBestPage(name, season) {
  return searchTitle(name).then(function (results) {
    if (!results.length) return null;

    var scored = results.map(function (r) {
      var cleanTitle = r.title.replace(/Hindi Dubbed|Episodes|Download|HD|FHD/gi, '').trim();
      var dist = levenshtein.get(cleanTitle.toLowerCase(), name.toLowerCase());

      if (season) {
        var seasonRegex = new RegExp('season[-\\s]?0*' + season + '(?!\\d)', 'i');
        if (!seasonRegex.test(r.url) && !seasonRegex.test(r.title)) dist += 3;
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
// Step 1: find codedew.com/zipper/ links on the episode/season page
// -----------------------------------------------------------------------------
function findRedirectLinks(pageUrl, episode) {
  return fetchText(pageUrl).then(function (html) {
    if (!html) return [];
    var $ = cheerio.load(html);
    var links = [];

    $('a[href*="codedew.com"]').each(function (_i, el) {
      var href = $(el).attr('href');
      var label = $(el).text().trim();
      if (!href) return;

      if (episode) {
        var context = $(el).closest('tr, li, .episode-item, .ep-item, p, div').text();
        var epMatch = context.match(/(?:episode|ep|S\d+\s*E)\s*0*(\d+)/i);
        if (epMatch && parseInt(epMatch[1]) !== parseInt(episode)) return;
      }

      links.push({ url: href, label: label || 'Server' });
    });

    return links;
  });
}

// -----------------------------------------------------------------------------
// Step 2: follow a codedew.com/zipper/ link -> lands on the streambeta player
// page. Step 3: scan that page's HTML/inline JSON for the final playable
// "workers.dev" source URL (Cloudflare Worker proxying the real video file).
// -----------------------------------------------------------------------------
function extractJsArray(html, varName) {
  // Matches: let/const playerSources = [ ... ];   (non-greedy up to the
  // matching closing "];" that ends the statement)
  var re = new RegExp('(?:let|const|var)\\s+' + varName + '\\s*=\\s*(\\[[\\s\\S]*?\\]);');
  var match = html.match(re);
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    console.log('[RareAnimes] Failed to parse ' + varName + ': ' + e.message);
    return [];
  }
}

function resolveStreamsFromRedirect(redirectUrl, episodeLabel) {
  return fetchText(redirectUrl).then(function (html) {
    if (!html) return [];

    var streams = [];

    var playerSources = extractJsArray(html, 'playerSources');
    playerSources.forEach(function (src) {
      var url = src.stream_url || src.url;
      if (url) {
        streams.push({
          name: 'RareAnimes - ' + (src.name || 'Server'),
          title: episodeLabel + ' - ' + (src.name || 'Server') + ' (Stream)',
          url: url,
          behaviorHints: { bingeGroup: 'rareanimes-stream' }
        });
      }
    });

    var downloadSources = extractJsArray(html, 'downloadSources');
    downloadSources.forEach(function (src) {
      var url = src.stream_url || src.url;
      if (url) {
        streams.push({
          name: 'RareAnimes - ' + (src.name || 'Server') + ' (DL)',
          title: episodeLabel + ' - ' + (src.name || 'Server') + ' (Download)',
          url: url,
          behaviorHints: { bingeGroup: 'rareanimes-download' }
        });
      }
    });

    // De-dupe by URL (playerSources and downloadSources often overlap on Server 1)
    var seen = {};
    var deduped = [];
    streams.forEach(function (s) {
      if (!seen[s.url]) {
        seen[s.url] = true;
        deduped.push(s);
      }
    });

    if (!deduped.length) {
      console.log('[RareAnimes] No playerSources/downloadSources found on: ' + redirectUrl);
    }

    return deduped;
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

      return findRedirectLinks(pageUrl, isSeries ? episode : null).then(function (redirects) {
        if (!redirects.length) {
          console.log('[RareAnimes] No codedew.com links found on page');
          return [];
        }

        var episodeLabel = title + (isSeries ? ' S' + season + 'E' + episode : '');

        var promises = redirects.map(function (r) {
          return resolveStreamsFromRedirect(r.url, episodeLabel);
        });

        return Promise.all(promises).then(function (results) {
          var streams = [];
          results.forEach(function (arr) {
            arr.forEach(function (s) { streams.push(s); });
          });

          // De-dupe across multiple redirect links too (e.g. same episode
          // listed twice with different labels on the source page)
          var seen = {};
          var deduped = [];
          streams.forEach(function (s) {
            if (!seen[s.url]) {
              seen[s.url] = true;
              deduped.push(s);
            }
          });

          return deduped;
        });
      });
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
