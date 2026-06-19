// =============================================================================
// AnimeDekho Nuvio Provider
// Ported from phisher98's CloudStream extension
// =============================================================================

const BASE_URL = 'https://animedekho.app';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';

// -----------------------------------------------------------------------------
// atob Polyfill
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

// -----------------------------------------------------------------------------
// JsUnpacker (p,a,c,k,e,d) unpacker
// -----------------------------------------------------------------------------
function jsUnpack(packed) {
  try {
    const p = /\}\('(.+)',(\d+),(\d+),'([^']+)'\.split\('\|'\)/.exec(packed);
    if (!p) return null;
    let [, payload, radix, , wordsStr] = p;
    radix = parseInt(radix);
    const words = wordsStr.split('|');
    payload = payload.replace(/\b(\w+)\b/g, (_, w) => {
      const idx = parseInt(w, radix);
      return words[idx] || w;
    });
    return payload;
  } catch (e) {
    return null;
  }
}

function getBaseUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch (e) {
    return url;
  }
}

function levenshtein(s, t) {
  if (s === t) return 0;
  const n = s.length, m = t.length;
  if (!n) return m;
  if (!m) return n;
  const d = Array.from({ length: n + 1 }, (_, i) => [i]);
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[n][m];
}

function fetchText(url, options) {
  options = options || {};
  const headers = Object.assign({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': BASE_URL + '/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }, options.headers || {});
  return fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body || undefined
  })
    .then(r => r.text())
    .catch(e => {
      console.log('[AnimeDekho] fetchText failed ' + url + ': ' + e.message);
      return null;
    });
}

function fetchJson(url, options) {
  options = options || {};
  const headers = Object.assign({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }, options.headers || {});
  return fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body || undefined
  })
    .then(r => r.json())
    .catch(e => {
      console.log('[AnimeDekho] fetchJson failed ' + url + ': ' + e.message);
      return null;
    });
}

function getAttr(html, selector, attr) {
  const re = new RegExp(`<${selector}[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, 'i');
  const m = re.exec(html);
  return m ? m[1] : null;
}

function getAllAttrs(html, selector, attr) {
  const re = new RegExp(`<${selector}[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(html)) !== null) results.push(m[1]);
  return results;
}

function getBodyClass(html) {
  const m = /<body[^>]*\sclass=["']([^"']+)["'][^>]*>/i.exec(html);
  return m ? m[1] : '';
}

function getPostId(html) {
  const bodyClass = getBodyClass(html);
  const m = /(?:term|postid)-(\d+)/.exec(bodyClass);
  return m ? m[1] : null;
}

function getTextBetweenTags(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  const m = re.exec(html);
  return m ? m[1].trim() : null;
}

function getMetaContent(html, property) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const m1 = re.exec(html);
  if (m1) return m1[1];
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["'][^>]*>`, 'i');
  const m2 = re2.exec(html);
  return m2 ? m2[1] : null;
}

function getAllSelectOptions(html, selectId) {
  const selectRe = new RegExp(`<select[^>]*id=["']${selectId}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'i');
  const sm = selectRe.exec(html);
  if (!sm) return [];
  const optRe = /<option[^>]*value=["']([^"']+)["'][^>]*>([^<]*)<\/option>/gi;
  const results = [];
  let m;
  while ((m = optRe.exec(sm[1])) !== null) {
    results.push({ value: m[1], text: m[2].trim() });
  }
  return results;
}

function getTmdbDetails(tmdbId, type) {
  const isSeries = type === 'series' || type === 'tv' || type === 'show';
  const url = `https://api.themoviedb.org/3/${isSeries ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url)
    .then(r => r.json())
    .then(data => isSeries
      ? { title: data.name, year: data.first_air_date ? parseInt(data.first_air_date.split('-')[0]) : 0 }
      : { title: data.title, year: data.release_date ? parseInt(data.release_date.split('-')[0]) : 0 })
    .catch(() => null);
}

function searchTitle(name) {
  const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(name)}`;
  return fetchText(searchUrl).then(html => {
    if (!html) return [];
    const results = [];
    const linkRe = /<article[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<h2[^>]*>([^<]+)<\/h2>/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      results.push({ url: m[1], title: m[2].trim() });
    }
    if (!results.length) {
      const linkRe2 = /<a[^>]+href=["'](https?:\/\/animedekho\.app\/[^"']+)["'][^>]*class=["'][^"']*lnk-blk[^"']*["'][^>]*>/gi;
      while ((m = linkRe2.exec(html)) !== null) {
        results.push({ url: m[1], title: '' });
      }
    }
    return results;
  });
}

function findBestMatch(results, targetTitle) {
  if (!results.length) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const target = norm(targetTitle);
  let best = null, bestScore = Infinity;
  for (const r of results) {
    const dist = levenshtein(norm(r.title), target);
    if (dist < bestScore) {
      bestScore = dist;
      best = r;
    }
  }
  return best;
}

async function getEpisodeUrl(seriesPageHtml, season, episode) {
  const epRe = /<li[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<h3[^>]*>[\s\S]*?<span[^>]*>S(\d+)-?E?(\d+)?<\/span>/gi;
  let m;
  while ((m = epRe.exec(seriesPageHtml)) !== null) {
    const sNum = parseInt(m[2]);
    const eNum = m[3] ? parseInt(m[3]) : null;
    if (sNum === season && (eNum === null || eNum === episode)) return m[1];
  }
  const allLinks = [];
  const allRe = /<li[^>]*>[\s\S]*?<a[^>]+href=["'](https?:\/\/animedekho\.app\/[^"']+)["'][^>]*>/gi;
  while ((m = allRe.exec(seriesPageHtml)) !== null) allLinks.push(m[1]);
  const idx = (season - 1) * 100 + (episode - 1);
  return allLinks[idx] || allLinks[0] || null;
}

async function extractGDMirrorbot(url, referer, streamCallback) {
  try {
    let sid = url.split('/').pop();
    let host = getBaseUrl(url);

    const pageText = await fetchText(url, { headers: { Referer: referer || BASE_URL } });
    if (!pageText) return;

    if (url.includes('key=')) {
      const finalId = /FinalID\s*=\s*"([^"]+)"/.exec(pageText)?.[1];
      const myKey = /myKey\s*=\s*"([^"]+)"/.exec(pageText)?.[1];
      const idType = /idType\s*=\s*"([^"]+)"/.exec(pageText)?.[1] || 'imdbid';
      const baseUrlMatch = /let\s+baseUrl\s*=\s*"([^"]+)"/.exec(pageText)?.[1];
      host = baseUrlMatch ? getBaseUrl(baseUrlMatch) : getBaseUrl(url);

      let apiPage = pageText;
      if (finalId && myKey) {
        let apiUrl;
        if (url.includes('/tv/')) {
          const seasonM = /\/tv\/\d+\/(\d+)\//.exec(url);
          const epM = /\/tv\/\d+\/\d+\/(\d+)/.exec(url);
          const s = seasonM ? seasonM[1] : '1';
          const e = epM ? epM[1] : '1';
          apiUrl = `${getBaseUrl(url)}/myseriesapi?tmdbid=${finalId}&season=${s}&epname=${e}&key=${myKey}`;
        } else {
          apiUrl = `${getBaseUrl(url)}/mymovieapi?${idType}=${finalId}&key=${myKey}`;
        }
        apiPage = await fetchText(apiUrl) || pageText;
      }

      let parsed;
      try { parsed = JSON.parse(apiPage); } catch { return; }
      const items = parsed?.data;
      sid = Array.isArray(items) && items[0]?.fileslug ? items[0].fileslug : sid;
    }

    const resp = await fetch(`${host}/embedhelper.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': url,
        'User-Agent': 'Mozilla/5.0'
      },
      body: `sid=${encodeURIComponent(sid)}`
    }).then(r => r.json()).catch(() => null);

    if (!resp) return;

    const siteUrls = resp.siteUrls || {};
    const friendlyNames = resp.siteFriendlyNames || {};
    let mresult = resp.mresult;

    if (typeof mresult === 'string') {
      try { mresult = JSON.parse(atob(mresult)); } catch { return; }
    }
    if (!mresult || typeof mresult !== 'object') return;

    for (const key of Object.keys(siteUrls)) {
      if (!mresult[key]) continue;
      const base = siteUrls[key].replace(/\/$/, '');
      const path = mresult[key].replace(/^\//, '');
      const fullUrl = `${base}/${path}`;
      const friendly = friendlyNames[key] || key;
      await extractByUrl(fullUrl, url, friendly, streamCallback);
    }
  } catch (e) {
    console.log('[AnimeDekho][GDMirrorbot] Error: ' + e.message);
  }
}

async function extractAWSStream(url, referer, streamCallback) {
  try {
    const hash = url.split('/').pop();
    const mainUrl = getBaseUrl(url);
    const apiUrl = `${mainUrl}/player/index.php?data=${hash}&do=getVideo}`;
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': url,
        'User-Agent': 'Mozilla/5.0'
      },
      body: `hash=${encodeURIComponent(hash)}&r=${encodeURIComponent(mainUrl)}`
    }).then(r => r.json()).catch(() => null);

    if (resp?.videoSource) {
      streamCallback({
        url: resp.videoSource,
        quality: '1080p',
        name: 'AWSStream',
        headers: { Referer: url }
      });
    }
  } catch (e) {
    console.log('[AnimeDekho][AWSStream] Error: ' + e.message);
  }
}

async function extractAnimedekhoco(url, referer, streamCallback) {
  try {
    const html = await fetchText(url, { headers: { Referer: referer || BASE_URL } });
    if (!html) return;

    if (url.includes('url=')) {
      const options = getAllSelectOptions(html, 'serverSelector');
      for (const opt of options) {
        if (opt.value) {
          streamCallback({
            url: opt.value,
            quality: 'Unknown',
            name: `Animedekhoco [${opt.text}]`,
            headers: { Referer: url }
          });
        }
      }
    } else {
      const fileM = /file\s*:\s*["']([^"']+)["']/.exec(html);
      if (fileM) {
        streamCallback({
          url: fileM[1],
          quality: 'Unknown',
          name: 'Animedekhoco',
          headers: { Referer: url }
        });
      }
    }
  } catch (e) {
    console.log('[AnimeDekho][Animedekhoco] Error: ' + e.message);
  }
}

async function extractStreamRuby(url, referer, streamCallback) {
  try {
    const cleanUrl = url.replace('/e', '');
    const html = await fetchText(cleanUrl, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Referer: cleanUrl
      }
    });
    if (!html) return;

    const m = /file:"(.*?)"/.exec(html) || /file\s*:\s*["']([^"']+)["']/.exec(html);
    if (m) {
      streamCallback({
        url: m[1],
        quality: '1080p',
        name: 'StreamRuby',
        headers: {
          Referer: cleanUrl,
          Origin: cleanUrl,
          Accept: '*/*',
          'Sec-Fetch-Mode': 'cors'
        }
      });
    }
  } catch (e) {
    console.log('[AnimeDekho][StreamRuby] Error: ' + e.message);
  }
}

async function extractBlakiteapi(url, referer, streamCallback) {
  try {
    const mainUrl = getBaseUrl(url);
    const id = url.split('/').pop();
    const tmdbId = url.split('embed/')[1]?.split('/')[0] || '';
    const apiUrl = `${mainUrl}/api/get.php?id=${id}&tmdbId=${tmdbId}`;
    const resp = await fetchJson(apiUrl);
    if (resp?.success && resp.data) {
      const { quality, format, dataId } = resp.data;
      const streamUrl = `${mainUrl}/stream/${dataId}.${format}`;
      streamCallback({
        url: streamUrl,
        quality: quality || 'Unknown',
        name: 'Blakiteapi',
        headers: { Referer: url }
      });
    }
  } catch (e) {
    console.log('[AnimeDekho][Blakiteapi] Error: ' + e.message);
  }
}

async function extractAbyass(url, referer, streamCallback) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Origin': 'https://playhydrax.com',
      'Referer': 'https://playhydrax.com/'
    };
    const html = await fetchText(url, { headers });
    if (!html) return;
    const encM = /const\s+datas\s*=\s*"([^"]+)"/.exec(html);
    if (!encM) return;

    const decResp = await fetch('https://enc-dec.app/api/dec-abyss', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: encM[1] })
    }).then(r => r.json()).catch(() => null);

    if (!decResp?.result?.sources) return;
    for (const src of decResp.result.sources) {
      if (!src.status) continue;
      streamCallback({
        url: src.url,
        quality: src.type || 'Unknown',
        name: `Abyass [${src.codec?.toUpperCase() || 'AVC'}]`,
        headers: { Referer: 'https://playhydrax.com/' }
      });
    }
  } catch (e) {
    console.log('[AnimeDekho][Abyass] Error: ' + e.message);
  }
}

async function extractGeneric(url, referer, name, streamCallback) {
  try {
    const html = await fetchText(url, { headers: { Referer: referer || url } });
    if (!html) return;

    const packM = /eval\(function\(p,a,c,k,e,(?:d|s)\)/.exec(html);
    let workHtml = html;
    if (packM) {
      const unpacked = jsUnpack(html.slice(packM.index));
      if (unpacked) workHtml += '\n' + unpacked;
    }

    const m3u8 = /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/.exec(workHtml);
    if (m3u8) {
      streamCallback({
        url: m3u8[1],
        quality: 'Unknown',
        name,
        headers: { Referer: url }
      });
      return;
    }

    const fileM = /file\s*:\s*["']([^"']+)["']/.exec(workHtml) ||
                  /source\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/.exec(workHtml);
    if (fileM) {
      streamCallback({
        url: fileM[1],
        quality: 'Unknown',
        name,
        headers: { Referer: url }
      });
      return;
    }

    const mp4 = /["'](https?:\/\/[^"']+\.mp4[^"']*)["']/.exec(workHtml);
    if (mp4) {
      streamCallback({
        url: mp4[1],
        quality: 'Unknown',
        name,
        headers: { Referer: url }
      });
    }
  } catch (e) {
    console.log(`[AnimeDekho][${name}] Generic error: ` + e.message);
  }
}

async function extractByUrl(url, referer, name, streamCallback) {
  if (!url) return;
  const cleanUrl = url.startsWith('//') ? 'https:' + url : url;

  if (cleanUrl.includes('gdmirrorbot.nl') || cleanUrl.includes('techinmind.space')) {
    return extractGDMirrorbot(cleanUrl, referer, streamCallback);
  }
  if (cleanUrl.includes('awstream.net') || cleanUrl.includes('as-cdn21.top')) {
    return extractAWSStream(cleanUrl, referer, streamCallback);
  }
  if (cleanUrl.includes('animedekho.co')) {
    return extractAnimedekhoco(cleanUrl, referer, streamCallback);
  }
  if (cleanUrl.includes('rubystm.com')) {
    return extractStreamRuby(cleanUrl, referer, streamCallback);
  }
  if (cleanUrl.includes('blakiteapi.xyz')) {
    return extractBlakiteapi(cleanUrl, referer, streamCallback);
  }
  if (cleanUrl.includes('abyssplayer.com') || cleanUrl.includes('playhydrax.com')) {
    return extractAbyass(cleanUrl, referer, streamCallback);
  }
  return extractGeneric(cleanUrl, referer, name || 'Stream', streamCallback);
}

async function extractStreamsFromPage(media, streamCallback) {
  const watchUrl = media.url;
  const mediaType = media.mediaType || 2;

  try {
    const vidstreamHtml 
