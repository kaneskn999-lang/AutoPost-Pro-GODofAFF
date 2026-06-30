/**
 * TikTok & Instagram Fetcher - Cloudflare Worker + R2
 *
 * Endpoints:
 *   POST   /api/preview        - ดูตัวอย่างคลิป (ไม่บันทึก)
 *   POST   /api/fetch          - ดึงคลิป → เก็บใน R2
 *   GET    /api/clips          - รายการคลิปทั้งหมด
 *   GET    /api/clips/:id      - ข้อมูล metadata ของคลิป
 *   GET    /api/clips/:id/video - สตรีมวิดีโอจาก R2
 *   DELETE /api/clips/:id      - ลบคลิป
 *
 * Supported Sources:
 *   - TikTok (via TikWM API)
 *   - Instagram Reels (via direct page scraping)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ─── CORS ───
    if (request.method === 'OPTIONS') {
      return corsResponse(env, new Response(null, { status: 204 }));
    }

    try {
      // ─── Routes ───
      if (path === '/api/preview' && request.method === 'POST') {
        return corsResponse(env, await handlePreview(request));
      }

      if (path === '/api/scrape-product' && request.method === 'POST') {
        return corsResponse(env, await handleScrapeProduct(request));
      }

      if (path === '/api/proxy-video' && request.method === 'GET') {
        return corsResponse(env, await handleProxyVideo(request));
      }

      if (path === '/api/fetch' && request.method === 'POST') {
        return corsResponse(env, await handleFetch(request, env));
      }

      if (path === '/api/clips' && request.method === 'GET') {
        return corsResponse(env, await handleList(env));
      }

      const clipMatch = path.match(/^\/api\/clips\/([a-zA-Z0-9_-]+)$/);
      if (clipMatch) {
        const id = clipMatch[1];
        if (request.method === 'GET') {
          return corsResponse(env, await handleGetClip(id, env));
        }
        if (request.method === 'DELETE') {
          return corsResponse(env, await handleDelete(id, env));
        }
      }

      const videoMatch = path.match(/^\/api\/clips\/([a-zA-Z0-9_-]+)\/video$/);
      if (videoMatch) {
        return corsResponse(env, await handleStreamVideo(videoMatch[1], env, request));
      }

      // ─── Health Check ───
      if (path === '/' || path === '/api/health') {
        return corsResponse(env, json({ status: 'ok', service: 'TikTok & IG Fetcher Worker', timestamp: new Date().toISOString() }));
      }

      return corsResponse(env, json({ error: 'Not Found' }, 404));

    } catch (err) {
      console.error('Worker error:', err);
      return corsResponse(env, json({ error: err.message || 'Internal Server Error' }, 500));
    }
  }
};


// ═══════════════════════════════════════════
// URL SOURCE DETECTION
// ═══════════════════════════════════════════

/**
 * Detect video source from URL
 * Returns: 'tiktok' | 'instagram' | 'unknown'
 */
function detectSource(url) {
  const u = url.toLowerCase();
  if (u.includes('tiktok.com') || u.includes('tiktok') || u.includes('vm.tiktok') || u.includes('vt.tiktok')) {
    return 'tiktok';
  }
  if (u.includes('instagram.com') || u.includes('instagr.am')) {
    return 'instagram';
  }
  if (u.includes('xhslink.com') || u.includes('xiaohongshu.com') || u.includes('xhs')) {
    return 'xiaohongshu';
  }
  return 'unknown';
}


// ═══════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════

/**
 * POST /api/preview
 * รับ { tiktokUrl } → ตรวจจับแหล่งที่มา → ดึงข้อมูล → ส่งกลับข้อมูล + preview URL
 */
async function handlePreview(request) {
  const body = await request.json();
  const clipUrl = body.tiktokUrl?.trim();

  if (!clipUrl) {
    return json({ error: 'กรุณาระบุลิงก์คลิป' }, 400);
  }

  const source = detectSource(clipUrl);

  if (source === 'tiktok') {
    return await previewTikTok(clipUrl);
  } else if (source === 'instagram') {
    return await previewInstagram(clipUrl);
  } else if (source === 'xiaohongshu') {
    return await previewXiaohongshu(clipUrl);
  } else {
    // Default: try TikTok first (supports some short URLs)
    try {
      return await previewTikTok(clipUrl);
    } catch {
      return json({ error: 'ไม่รองรับ URL นี้ กรุณาใช้ลิงก์ TikTok, Instagram หรือ Xiaohongshu' }, 400);
    }
  }
}

/**
 * Preview: TikTok via TikWM
 */
async function previewTikTok(clipUrl) {
  const tiktokData = await fetchTikTokData(clipUrl);
  const data = tiktokData.data;

  const videoUrl = getBestVideoUrl(data);
  if (!videoUrl) {
    return json({ error: 'ไม่พบ URL วิดีโอจาก TikWM' }, 502);
  }

  return json({
    success: true,
    preview: {
      tiktokUrl: clipUrl,
      source: 'tiktok',
      title: data.title || '',
      duration: data.duration || 0,
      videoUrl: videoUrl,
      coverUrl: data.cover || data.origin_cover || '',
      author: {
        nickname: data.author?.nickname || '',
        uniqueId: data.author?.unique_id || '',
        avatar: data.author?.avatar || ''
      },
      stats: {
        plays: data.play_count || 0,
        likes: data.digg_count || 0,
        comments: data.comment_count || 0,
        shares: data.share_count || 0,
        collects: data.collect_count || 0
      }
    }
  });
}

/**
 * Preview: Instagram Reel
 */
async function previewInstagram(clipUrl) {
  const igData = await fetchInstagramData(clipUrl);

  return json({
    success: true,
    preview: {
      tiktokUrl: clipUrl,
      source: 'instagram',
      title: igData.title || '',
      duration: igData.duration || 0,
      videoUrl: igData.videoUrl,
      coverUrl: igData.coverUrl || '',
      author: {
        nickname: igData.author?.nickname || '',
        uniqueId: igData.author?.uniqueId || '',
        avatar: igData.author?.avatar || ''
      },
      stats: {
        plays: igData.stats?.plays || 0,
        likes: igData.stats?.likes || 0,
        comments: igData.stats?.comments || 0,
        shares: 0,
        collects: 0
      }
    }
  });
}


/**
 * POST /api/fetch
 * รับ { tiktokUrl, productUrl } → ดึงข้อมูลจากแหล่งที่ตรวจจับ → ดาวน์โหลด MP4 → อัปโหลดไป R2
 */
async function handleFetch(request, env) {
  if (!env.CLIPS_BUCKET) {
    return json({ error: 'R2 storage is not configured' }, 501);
  }
  const body = await request.json();
  const clipUrl = body.tiktokUrl?.trim();
  const productUrl = body.productUrl?.trim() || '';
  const productName = body.productName?.trim() || '';
  const platform = body.platform?.trim() || '';
  const note = body.note?.trim() || '';
  const customTitle = body.title?.trim() || '';

  if (!clipUrl) {
    return json({ error: 'กรุณาระบุลิงก์คลิป' }, 400);
  }

  const source = detectSource(clipUrl);
  let videoUrl, extractedData;

  if (source === 'instagram') {
    // ─── Instagram Reel ───
    const igData = await fetchInstagramData(clipUrl);
    videoUrl = igData.videoUrl;
    extractedData = {
      title: igData.title || '',
      duration: igData.duration || 0,
      author: igData.author || { nickname: '', uniqueId: '', avatar: '' },
      stats: igData.stats || { plays: 0, likes: 0, comments: 0, shares: 0, collects: 0 }
    };
  } else if (source === 'xiaohongshu') {
    // ─── Xiaohongshu ───
    const xhsData = await fetchXiaohongshuData(clipUrl);
    videoUrl = xhsData.videoUrl;
    extractedData = {
      title: xhsData.title || '',
      duration: xhsData.duration || 0,
      author: xhsData.author || { nickname: '', uniqueId: '', avatar: '' },
      stats: xhsData.stats || { plays: 0, likes: 0, comments: 0, shares: 0, collects: 0 }
    };
  } else {
    // ─── TikTok (default) ───
    const tiktokData = await fetchTikTokData(clipUrl);
    const data = tiktokData.data;
    videoUrl = getBestVideoUrl(data);
    extractedData = {
      title: data.title || '',
      duration: data.duration || 0,
      author: {
        nickname: data.author?.nickname || '',
        uniqueId: data.author?.unique_id || '',
        avatar: data.author?.avatar || ''
      },
      stats: {
        plays: data.play_count || 0,
        likes: data.digg_count || 0,
        comments: data.comment_count || 0,
        shares: data.share_count || 0,
        collects: data.collect_count || 0
      }
    };
  }

  if (!videoUrl) {
    return json({ error: 'ไม่พบ URL วิดีโอ' }, 502);
  }

  // 3) ดาวน์โหลดวิดีโอ
  const videoRes = await fetch(videoUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': source === 'instagram' ? 'https://www.instagram.com/' : 'https://www.tiktok.com/'
    }
  });

  if (!videoRes.ok) {
    return json({ error: `ดาวน์โหลดวิดีโอไม่สำเร็จ: ${videoRes.status}` }, 502);
  }

  const videoBuffer = await videoRes.arrayBuffer();
  const videoSize = videoBuffer.byteLength;

  // 4) สร้าง ID & Metadata
  const clipId = generateId();
  const now = new Date().toISOString();

  const metadata = {
    id: clipId,
    tiktokUrl: clipUrl,
    source: source,
    productUrl: productUrl,
    productName: productName,
    platform: platform,
    note: note,
    title: customTitle || extractedData.title,
    duration: extractedData.duration,
    author: extractedData.author,
    stats: extractedData.stats,
    fileSize: videoSize,
    createdAt: now,
    status: 'saved'
  };

  // 5) อัปโหลดวิดีโอไป R2
  await env.CLIPS_BUCKET.put(`clips/${clipId}.mp4`, videoBuffer, {
    httpMetadata: {
      contentType: 'video/mp4',
    },
    customMetadata: {
      clipId: clipId,
      source: source,
      title: metadata.title.substring(0, 200),
      createdAt: now
    }
  });

  // 6) อัปโหลด metadata ไป R2
  await env.CLIPS_BUCKET.put(`meta/${clipId}.json`, JSON.stringify(metadata, null, 2), {
    httpMetadata: {
      contentType: 'application/json',
    }
  });

  // 7) อัปเดต index
  await updateIndex(env, clipId, {
    id: clipId,
    source: source,
    title: metadata.title.substring(0, 400),
    author: metadata.author.nickname,
    productUrl: productUrl,
    productName: productName,
    platform: platform,
    note: note,
    duration: metadata.duration,
    fileSize: videoSize,
    createdAt: now,
    status: 'saved'
  });

  return json({
    success: true,
    clip: metadata,
    videoUrl: `/api/clips/${clipId}/video`,
    message: 'ดึงคลิปและบันทึกสำเร็จ!'
  });
}


/**
 * GET /api/clips
 * รายการคลิปทั้งหมด
 */
async function handleList(env) {
  if (!env.CLIPS_BUCKET) {
    return json({ clips: [], total: 0 });
  }
  const indexObj = await env.CLIPS_BUCKET.get('index.json');

  if (!indexObj) {
    return json({ clips: [], total: 0 });
  }

  const index = await indexObj.json();
  // เรียงจากใหม่ไปเก่า
  index.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return json({ clips: index, total: index.length });
}


/**
 * GET /api/clips/:id
 * ข้อมูล metadata ของคลิป
 */
async function handleGetClip(id, env) {
  if (!env.CLIPS_BUCKET) {
    return json({ error: 'R2 storage is not configured' }, 501);
  }
  const metaObj = await env.CLIPS_BUCKET.get(`meta/${id}.json`);

  if (!metaObj) {
    return json({ error: 'ไม่พบคลิปนี้' }, 404);
  }

  const metadata = await metaObj.json();
  metadata.videoUrl = `/api/clips/${id}/video`;

  return json(metadata);
}


/**
 * GET /api/clips/:id/video
 * สตรีมวิดีโอจาก R2 (รองรับ Range requests)
 */
async function handleStreamVideo(id, env, request) {
  if (!env.CLIPS_BUCKET) {
    return json({ error: 'R2 storage is not configured' }, 501);
  }
  const obj = await env.CLIPS_BUCKET.get(`clips/${id}.mp4`, {
    range: request.headers,
  });

  if (!obj) {
    return json({ error: 'ไม่พบไฟล์วิดีโอ' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=86400');

  if (obj.range) {
    headers.set('Content-Range', `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`);
    headers.set('Content-Length', obj.range.length);
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set('Content-Length', obj.size);
  return new Response(obj.body, { status: 200, headers });
}


/**
 * DELETE /api/clips/:id
 * ลบคลิปออกจาก R2
 */
async function handleDelete(id, env) {
  if (!env.CLIPS_BUCKET) {
    return json({ error: 'R2 storage is not configured' }, 501);
  }
  // ลบไฟล์วิดีโอ
  await env.CLIPS_BUCKET.delete(`clips/${id}.mp4`);
  // ลบ metadata
  await env.CLIPS_BUCKET.delete(`meta/${id}.json`);
  // อัปเดต index
  await removeFromIndex(env, id);

  return json({ success: true, message: 'ลบคลิปสำเร็จ' });
}


// ═══════════════════════════════════════════
// TIKTOK HELPERS (TikWM API)
// ═══════════════════════════════════════════

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTikTokData(tiktokUrl) {
  const cacheKey = new Request(`https://cache.local/tiktok?url=${encodeURIComponent(tiktokUrl)}`);
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return await cached.json();
  } catch (e) {
    console.warn('TikTok cache read failed:', e?.message || e);
  }

  const providers = [
    { name: 'Tioo', fetcher: fetchTiooTikTok },
    { name: 'TikWM', fetcher: fetchTikWM },
    { name: 'Lovetik', fetcher: fetchLovetikTikTok },
    { name: 'Azbry', fetcher: fetchAzbryTikTok }
  ];
  const errors = [];

  for (const provider of providers) {
    try {
      const data = await provider.fetcher(tiktokUrl);
      if (data?.data && getBestVideoUrl(data.data)) {
        data.provider = provider.name;
        try {
          await caches.default.put(cacheKey, new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' }
          }));
        } catch (e) {
          console.warn('TikTok cache write failed:', e?.message || e);
        }
        return data;
      }
      errors.push(`${provider.name}: no video URL`);
    } catch (err) {
      errors.push(`${provider.name}: ${err.message || err}`);
      console.log(`TikTok provider failed (${provider.name}):`, err.message || err);
    }
  }

  throw new Error(`All TikTok providers failed. ${errors.join(' | ')}`);
}

/**
 * เรียก TikWM API และ return parsed data (พร้อมระบบ Retry แบบ Random Jitter Backoff เมื่อเจอ Rate Limit)
 */
async function fetchTikWM(tiktokUrl) {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}`;
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const tikwmRes = await fetch(apiUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      });

      if (!tikwmRes.ok) {
        throw new Error(`TikWM API error: ${tikwmRes.status}`);
      }

      const tikwmData = await tikwmRes.json();

      if (tikwmData.code !== 0 || !tikwmData.data) {
        const errorMsg = tikwmData.msg || 'ไม่สามารถดึงข้อมูลคลิปจาก TikWM ได้';
        // ตรวจสอบว่าเป็นข้อผิดพลาดจาก Rate Limit (1 request/second)
        if (errorMsg.includes('Limit') || errorMsg.includes('request/second') || tikwmData.code === -1) {
          if (attempt < maxAttempts) {
            console.log(`TikWM rate limit hit: "${errorMsg}". Retrying in 1.5s (attempt ${attempt}/${maxAttempts})...`);
            await sleep(1500 + Math.random() * 500); // ดีเลย์ 1.5 - 2 วินาที (Jitter) เพื่อหลบเลี่ยงการชนกันของคิว
            continue;
          }
        }
        throw new Error(errorMsg);
      }

      return tikwmData;
    } catch (err) {
      if (attempt === maxAttempts) {
        throw err;
      }
      console.log(`TikWM fetch error: ${err.message}. Retrying in 1.5s (attempt ${attempt}/${maxAttempts})...`);
      await sleep(1500 + Math.random() * 500);
    }
  }
}

/**
 * เรียก Tioo API (btch-downloader backend)
 */
async function fetchTiooTikTok(tiktokUrl) {
  const apiUrl = `https://backend1.tioo.eu.org/ttdl?url=${encodeURIComponent(tiktokUrl)}`;
  const res = await fetch(apiUrl, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });

  if (!res.ok) {
    throw new Error(`Tioo API error: ${res.status}`);
  }

  const payload = await res.json();
  if (!payload.status || !Array.isArray(payload.video)) {
    throw new Error(payload.message || 'Tioo did not return TikTok video links');
  }

  // กรองลิงก์ของ cdn.tioo.eu.org ออกเนื่องจากเซิร์ฟเวอร์ปลายทางมีปัญหา 522 Connection Timeout
  const videoLinks = payload.video.filter(link => link && !link.includes('cdn.tioo.eu.org'));
  if (videoLinks.length === 0) {
    throw new Error('Tioo did not return any working video links');
  }

  // ใช้ลิงก์วิดีโอตัวแรกและตัวสำรอง
  const play = videoLinks[0];
  const hdplay = videoLinks[1] || videoLinks[0];

  return {
    code: 0,
    msg: 'success',
    data: {
      title: payload.title || '',
      duration: 0,
      hdplay: hdplay,
      play: play,
      wmplay: '',
      cover: payload.thumbnail || '',
      origin_cover: payload.thumbnail || '',
      author: {
        nickname: '',
        unique_id: '',
        avatar: ''
      },
      play_count: 0,
      digg_count: 0,
      comment_count: 0,
      share_count: 0,
      collect_count: 0
    }
  };
}

/**
 * หา Video URL ที่ดีที่สุดจาก TikWM data
 */
async function fetchAzbryTikTok(tiktokUrl) {
  const apiUrl = `https://api.azbry.com/api/download/tiktok?url=${encodeURIComponent(tiktokUrl)}`;
  const res = await fetch(apiUrl, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });

  if (!res.ok) {
    throw new Error(`Azbry API error: ${res.status}`);
  }

  const payload = await res.json();
  if (!payload.status || !payload.result) {
    throw new Error(payload.message || 'Azbry did not return TikTok data');
  }

  const result = payload.result;
  const links = Array.isArray(result.links) ? result.links : [];
  return {
    code: 0,
    msg: 'success',
    data: {
      title: result.title || '',
      duration: result.duration || 0,
      hdplay: links[0] || '',
      play: links[1] || links[0] || '',
      wmplay: links[2] || '',
      cover: result.thumbnail || '',
      origin_cover: result.thumbnail || '',
      author: {
        nickname: result.author || '',
        unique_id: '',
        avatar: ''
      },
      play_count: 0,
      digg_count: 0,
      comment_count: 0,
      share_count: 0,
      collect_count: 0
    }
  };
}

async function fetchLovetikTikTok(tiktokUrl) {
  const url = 'https://lovetik.com/api/ajax/search';
  const params = new URLSearchParams();
  params.append('query', tiktokUrl);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    body: params.toString()
  });

  if (!res.ok) {
    throw new Error(`Lovetik API error: ${res.status}`);
  }

  const payload = await res.json();
  if (payload.status !== 'ok' || (payload.mess && payload.mess !== '')) {
    throw new Error(payload.mess || 'Lovetik did not return successful status');
  }

  const links = Array.isArray(payload.links) ? payload.links : [];
  
  const cleanLinks = links.filter(l => l.ft === 1 || l.ft === '1').map(l => l.a);
  const wmLinks = links.filter(l => l.ft === 2 || l.ft === '2').map(l => l.a);
  
  if (cleanLinks.length === 0) {
    throw new Error('Lovetik did not return any watermark-free video links');
  }

  const hdLinkObj = links.find(l => (l.ft === 1 || l.ft === '1') && (l.s?.includes('Original') || l.s?.includes('1080p')));
  const hdplay = hdLinkObj ? hdLinkObj.a : cleanLinks[0];
  const play = cleanLinks[0];
  const wmplay = wmLinks[0] || '';

  return {
    code: 0,
    msg: 'success',
    data: {
      title: payload.desc || '',
      duration: 0,
      hdplay: hdplay,
      play: play,
      wmplay: wmplay,
      cover: payload.cover || '',
      origin_cover: payload.cover || '',
      author: {
        nickname: payload.author_name || payload.author || '',
        unique_id: payload.author ? payload.author.replace('@', '') : '',
        avatar: payload.author_a || ''
      },
      play_count: 0,
      digg_count: 0,
      comment_count: 0,
      share_count: 0,
      collect_count: 0
    }
  };
}

function getBestVideoUrl(data) {
  if (data.hdplay) {
    return data.hdplay.startsWith('http') ? data.hdplay : `https://www.tikwm.com${data.hdplay}`;
  }
  if (data.play) {
    return data.play.startsWith('http') ? data.play : `https://www.tikwm.com${data.play}`;
  }
  return '';
}


// ═══════════════════════════════════════════
// INSTAGRAM HELPERS (Direct Page Scraping)
// ═══════════════════════════════════════════

/**
 * Normalize Instagram URL to full format
 */
function normalizeInstagramUrl(url) {
  // Handle shortened instagr.am links
  let normalUrl = url.replace('instagr.am', 'www.instagram.com');
  // Ensure https
  if (!normalUrl.startsWith('http')) {
    normalUrl = 'https://' + normalUrl;
  }
  return normalUrl;
}

/**
 * Extract Instagram Reel/Post shortcode from URL
 */
function extractIGShortcode(url) {
  // Match patterns like /reel/XXXX/, /p/XXXX/, /reels/XXXX/
  const match = url.match(/\/(reel|p|reels|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[2] : null;
}

/**
 * ดึงข้อมูล Instagram Reel/Post
 * ใช้วิธี scrape จาก Instagram embed page + oembed API
 */
async function fetchInstagramData(igUrl) {
  const normalUrl = normalizeInstagramUrl(igUrl);
  const shortcode = extractIGShortcode(normalUrl);

  if (!shortcode) {
    throw new Error('ไม่สามารถแยก shortcode จาก URL Instagram ได้ กรุณาตรวจสอบลิงก์');
  }

  // ─── Strategy 1: Try IG oEmbed API (for metadata) ───
  let title = '';
  let authorName = '';
  let authorUsername = '';
  let thumbnailUrl = '';

  try {
    const oembedUrl = `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(normalUrl)}`;
    const oembedRes = await fetch(oembedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      title = oembed.title || '';
      authorName = oembed.author_name || '';
      authorUsername = oembed.author_name || '';
      thumbnailUrl = oembed.thumbnail_url || '';
    }
  } catch (e) {
    console.log('oEmbed fetch failed (non-critical):', e.message);
  }

  // ─── Strategy 2: Fetch from Instagram embed page to get video URL ───
  let videoUrl = '';

  // Try embed page approach
  try {
    const embedUrl = `https://www.instagram.com/reel/${shortcode}/embed/captioned/`;
    const embedRes = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Twitterbot/1.0',
        'Accept': 'text/html'
      }
    });

    if (embedRes.ok) {
      const html = await embedRes.text();

      // Extract video URL from embed page
      // Look for video_url in the embedded data
      const videoPatterns = [
        /\\?"video_url\\?":\s*\\?"([^"]+?)\\?"/,
        /"video_url":"([^"]+)"/,
        /video_url\\?":\\?"([^"\\]+)/,
        /"contentUrl":\s*"([^"]+)"/,
        /property="og:video"\s+content="([^"]+)"/,
        /property="og:video:secure_url"\s+content="([^"]+)"/,
        /data-video-url="([^"]+)"/,
        /"src":"(https:\/\/[^"]*\.mp4[^"]*)"/
      ];

      for (const pattern of videoPatterns) {
        const match = html.match(pattern);
        if (match) {
          videoUrl = match[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
          break;
        }
      }

      // Also try to get caption from embed if we don't have one
      if (!title) {
        const captionMatch = html.match(/<div class="Caption"[^>]*>.*?<a[^>]*>([^<]*)<\/a>\s*(.*?)<\/div>/s);
        if (captionMatch) {
          title = (captionMatch[2] || '').replace(/<[^>]*>/g, '').trim().substring(0, 500);
        }
      }

      // Try to extract thumbnail if we don't have it
      if (!thumbnailUrl) {
        const thumbMatch = html.match(/property="og:image"\s+content="([^"]+)"/);
        if (thumbMatch) {
          thumbnailUrl = thumbMatch[1];
        }
      }
    }
  } catch (e) {
    console.log('Embed page fetch failed:', e.message);
  }

  // ─── Strategy 3: Try direct page with __a=1 (graphql endpoint) ───
  if (!videoUrl) {
    try {
      const graphqlUrl = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;
      const graphqlRes = await fetch(graphqlUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept': '*/*',
          'X-IG-App-ID': '936619743392459',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });

      if (graphqlRes.ok) {
        const graphqlData = await graphqlRes.json();
        const item = graphqlData?.items?.[0] || graphqlData?.graphql?.shortcode_media;
        if (item) {
          videoUrl = item.video_url || item.video_versions?.[0]?.url || '';
          if (!title) title = item.caption?.text || item.edge_media_to_caption?.edges?.[0]?.node?.text || '';
          if (!authorName) authorName = item.user?.full_name || item.owner?.full_name || '';
          if (!authorUsername) authorUsername = item.user?.username || item.owner?.username || '';
          if (!thumbnailUrl) thumbnailUrl = item.image_versions2?.candidates?.[0]?.url || item.display_url || '';
        }
      }
    } catch (e) {
      console.log('GraphQL fetch failed:', e.message);
    }
  }

  // ─── Strategy 4: Try alternative third-party API as last resort ───
  if (!videoUrl) {
    try {
      // Use a public downloader API as fallback
      const apiUrl = `https://api.saveig.app/api/ajaxSearch`;
      const formData = new URLSearchParams();
      formData.set('q', normalUrl);
      formData.set('t', 'media');
      formData.set('lang', 'en');

      const apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Origin': 'https://saveig.app',
          'Referer': 'https://saveig.app/'
        },
        body: formData.toString()
      });

      if (apiRes.ok) {
        const apiData = await apiRes.json();
        if (apiData.data) {
          // Extract video URL from HTML response
          const downloadMatch = apiData.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/);
          if (downloadMatch) {
            videoUrl = downloadMatch[1];
          }
          // Try other href patterns
          if (!videoUrl) {
            const altMatch = apiData.data.match(/href="(https:\/\/[^"]+)"/);
            if (altMatch) {
              videoUrl = altMatch[1];
            }
          }
        }
      }
    } catch (e) {
      console.log('Third-party API fallback failed:', e.message);
    }
  }

  if (!videoUrl) {
    throw new Error('ไม่สามารถดึงวิดีโอจาก Instagram ได้ ลิงก์อาจไม่ใช่ Public หรือ Instagram บล็อกการเข้าถึงชั่วคราว กรุณาลองใหม่อีกครั้ง');
  }

  return {
    videoUrl,
    title: title || '',
    duration: 0,
    coverUrl: thumbnailUrl,
    author: {
      nickname: authorName || authorUsername || '',
      uniqueId: authorUsername || '',
      avatar: ''
    },
    stats: {
      plays: 0,
      likes: 0,
      comments: 0
    }
  };
}


// ═══════════════════════════════════════════
// XIAOHONGSHU (RED) HELPERS
// ═══════════════════════════════════════════

async function previewXiaohongshu(clipUrl) {
  const xhsData = await fetchXiaohongshuData(clipUrl);
  return json({
    success: true,
    preview: {
      tiktokUrl: clipUrl,
      source: 'xiaohongshu',
      title: xhsData.title || '',
      duration: xhsData.duration || 0,
      videoUrl: xhsData.videoUrl,
      coverUrl: xhsData.coverUrl || '',
      author: xhsData.author || { nickname: '', uniqueId: '', avatar: '' },
      stats: xhsData.stats || { plays: 0, likes: 0, comments: 0, shares: 0, collects: 0 }
    }
  });
}

async function fetchXiaohongshuData(xhsUrl) {
  let targetUrl = xhsUrl;
  
  // Follow redirects for xhslink.com short links
  if (xhsUrl.includes('xhslink.com')) {
    const res = await fetch(xhsUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      redirect: 'follow'
    });
    targetUrl = res.url;
  }

  // Fetch the final page
  const pageRes = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }
  });

  if (!pageRes.ok) {
    throw new Error(`ไม่สามารถเข้าถึงหน้าเว็บ Xiaohongshu ได้: ${pageRes.status}`);
  }

  const html = await pageRes.text();
  
  // Extract window.__INITIAL_STATE__
  const startIndex = html.indexOf("window.__INITIAL_STATE__");
  if (startIndex === -1) {
    throw new Error('ไม่พบข้อมูลวิดีโอในหน้าเว็บ Xiaohongshu (__INITIAL_STATE__ not found)');
  }

  const braceIndex = html.indexOf("{", startIndex);
  if (braceIndex === -1) {
    throw new Error('โครงสร้างข้อมูลในหน้าเว็บ Xiaohongshu ไม่ถูกต้อง');
  }

  const endScriptIndex = html.indexOf("</script>", braceIndex);
  if (endScriptIndex === -1) {
    throw new Error('ปิดบล็อกสคริปต์ในหน้าเว็บ Xiaohongshu ไม่ถูกต้อง');
  }

  let scriptContent = html.substring(braceIndex, endScriptIndex).trim();
  if (scriptContent.endsWith(";")) {
    scriptContent = scriptContent.slice(0, -1).trim();
  }

  // Clean and parse JSON state
  const cleaned = scriptContent.replace(/:\s*undefined/g, ':null');
  let state;
  try {
    state = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('ไม่สามารถวิเคราะห์ข้อมูลวิดีโอจาก Xiaohongshu ได้: ' + err.message);
  }

  const noteId = state.note?.firstNoteId || state.note?.currentNoteId || state.note?.redFirstNoteId;
  const detail = state.note?.noteDetailMap?.[noteId];
  const note = detail?.note || state.note;
  if (!note || note.type !== 'video') {
    throw new Error('ลิงก์นี้ไม่ใช่วิดีโอ หรือไม่พบเนื้อหาของโน้ต (กรุณาใช้ลิงก์วิดีโอโพสต์เดี่ยว)');
  }

  const video = note.video;
  if (!video) {
    throw new Error('ไม่พบข้อมูลวิดีโอใน Xiaohongshu note');
  }

  // Extract video stream URL
  const h264Stream = video.media?.stream?.h264 || [];
  const h256Stream = video.media?.stream?.h265 || [];
  const bestStream = h264Stream[0] || h256Stream[0];
  const videoUrl = bestStream?.masterUrl || '';

  if (!videoUrl) {
    throw new Error('ไม่พบลิงก์วิดีโอจากหน้าเว็บ Xiaohongshu');
  }

  // Extract cover
  const coverUrl = note.imageList?.[0]?.urlDefault || note.imageList?.[0]?.url || '';

  // Extract author
  const authorName = note.user?.nickname || '';
  const authorId = note.user?.userId || '';
  const authorAvatar = note.user?.avatar || '';

  // Extract stats
  const stats = note.interactInfo || {};
  const likes = parseInt(stats.likedCount) || 0;
  const comments = parseInt(stats.commentCount) || 0;
  const collects = parseInt(stats.collectedCount) || 0;
  const shares = parseInt(stats.shareCount) || 0;

  return {
    videoUrl,
    title: note.title || note.desc || '',
    duration: video.media?.video?.duration || 0,
    coverUrl,
    author: {
      nickname: authorName,
      uniqueId: authorId,
      avatar: authorAvatar
    },
    stats: {
      plays: 0,
      likes,
      comments,
      shares,
      collects
    }
  };
}


// ═══════════════════════════════════════════
// COMMON HELPERS
// ═══════════════════════════════════════════

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const timestamp = Date.now().toString(36);
  let random = '';
  for (let i = 0; i < 6; i++) {
    random += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${timestamp}_${random}`;
}

async function updateIndex(env, clipId, entry) {
  let index = [];
  const indexObj = await env.CLIPS_BUCKET.get('index.json');
  if (indexObj) {
    index = await indexObj.json();
  }
  // เพิ่มรายการใหม่ (ไม่ให้ซ้ำ)
  index = index.filter(item => item.id !== clipId);
  index.unshift(entry);

  await env.CLIPS_BUCKET.put('index.json', JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json' }
  });
}

async function removeFromIndex(env, clipId) {
  const indexObj = await env.CLIPS_BUCKET.get('index.json');
  if (!indexObj) return;

  let index = await indexObj.json();
  index = index.filter(item => item.id !== clipId);

  await env.CLIPS_BUCKET.put('index.json', JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json' }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function decodeHtmlEntities(value) {
  if (!value) return '';
  const entities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    '#39': "'",
    nbsp: ' '
  };

  return String(value).replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === '#') {
      const codePoint = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(entities, key) ? entities[key] : match;
  });
}

function repairMojibake(value) {
  const text = String(value || '');
  if (!/[ÃÂâà]/.test(text)) return text;

  const windows1252 = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84,
    0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88,
    0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C,
    0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
    0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
    0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F
  };
  const chars = Array.from(text);

  try {
    const bytes = Uint8Array.from(chars.map(char => {
      const code = char.codePointAt(0);
      if (code <= 255) return code;
      if (Object.prototype.hasOwnProperty.call(windows1252, code)) return windows1252[code];
      throw new Error('unsupported mojibake character');
    }));
    const decoded = new TextDecoder('utf-8').decode(bytes);
    return /[\u0E00-\u0E7F]/.test(decoded) ? decoded : text;
  } catch (e) {
    return text;
  }
}

function cleanProductTitle(value) {
  return repairMojibake(decodeHtmlEntities(value))
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-|]\s*(Shopee|Lazada).*$/i, '')
    .trim()
    .substring(0, 220);
}

function isGenericProductTitle(value) {
  const normalized = cleanProductTitle(value).toLowerCase();
  return !normalized ||
    normalized === 'shopee' ||
    normalized === 'lazada' ||
    normalized.includes('shopee__') ||
    normalized.includes('lazada__');
}

async function handleProxyVideo(request) {
  const url = new URL(request.url).searchParams.get('url');
  if (!url) {
    return json({ error: 'Missing url parameter' }, 400);
  }

  const targetUrl = decodeURIComponent(url);

  // Download video from actual CDN with appropriate headers and Range header forwarding
  const rangeHeader = request.headers.get('Range');
  const headers = new Headers({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': targetUrl.includes('instagram.com') ? 'https://www.instagram.com/' : 'https://www.tiktok.com/'
  });
  if (rangeHeader) {
    headers.set('Range', rangeHeader);
  }

  const videoRes = await fetch(targetUrl, { headers });

  if (!videoRes.ok && videoRes.status !== 206) {
    return new Response(`Failed to fetch video from CDN: ${videoRes.status}`, { status: 502 });
  }

  // Set appropriate headers to pass Content-Type & Content-Length through
  const responseHeaders = new Headers();
  responseHeaders.set('Content-Type', videoRes.headers.get('Content-Type') || 'video/mp4');
  
  const contentLength = videoRes.headers.get('Content-Length');
  if (contentLength) {
    responseHeaders.set('Content-Length', contentLength);
  }

  const contentRange = videoRes.headers.get('Content-Range');
  if (contentRange) {
    responseHeaders.set('Content-Range', contentRange);
  }

  const acceptRanges = videoRes.headers.get('Accept-Ranges');
  if (acceptRanges) {
    responseHeaders.set('Accept-Ranges', acceptRanges);
  }

  // Stream video binary response (supports 206 Partial Content)
  return new Response(videoRes.body, {
    status: videoRes.status,
    headers: responseHeaders
  });
}

function corsResponse(env, response) {
  const origin = env.ALLOWED_ORIGIN || '*';
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * ดึงรูปภาพสินค้าภาพแรกจากลิงก์สินค้า Lazada หรือ Shopee
 */
async function handleScrapeProduct(request) {
  try {
    const body = await request.json();
    const productUrl = body.productUrl?.trim();
    if (!productUrl) {
      return json({ error: 'Missing productUrl' }, 400);
    }

    // เรียกดึงข้อมูลหน้าเว็บ
    const res = await fetch(productUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    });

    if (!res.ok) {
      return json({ error: `Failed to fetch product page: ${res.status}` }, 502);
    }

    const html = await res.text();
    const finalProductUrl = res.url || productUrl;
    let imageUrl = '';
    let imageUrls = [];
    let productTitle = extractProductTitleFromHtml(html);
    if (isGenericProductTitle(productTitle)) {
      productTitle = await scrapeShopeeProductTitle(productUrl, html);
    }

    // ─── STEP A: ค้นหารายชื่อไฟล์วิดีโอปก (Video Cover) เพื่อนำมาคัดกรองออก ───
    let videoCovers = [];
    const videoKeys = [
      /["']videoPic["']\s*:\s*["']([^"']+)["']/gi,
      /["']videoCover["']\s*:\s*["']([^"']+)["']/gi,
      /["']video_cover["']\s*:\s*["']([^"']+)["']/gi,
      /["']coverUrl["']\s*:\s*["']([^"']+)["']/gi
    ];
    for (const keyReg of videoKeys) {
      let match;
      while ((match = keyReg.exec(html)) !== null) {
        let vUrl = match[1];
        if (vUrl) {
          vUrl = vUrl.replace(/\\/g, '');
          const baseNameMatch = vUrl.match(/\/([a-zA-Z0-9_-]+)\.(jpg|png|webp|jpeg)/i);
          if (baseNameMatch) {
            videoCovers.push(baseNameMatch[1]);
          }
        }
      }
    }
    // เพิ่มการจับคู่แฮชวิดีโอเพิ่มเติมในโครงสร้างข้อมูล JSON
    if (html.includes('video')) {
      const videoPicReg = /"video(?:Pic|Cover|Url)":"([^"]+)"/gi;
      let match;
      while ((match = videoPicReg.exec(html)) !== null) {
        const baseNameMatch = match[1].replace(/\\/g, '').match(/\/([a-zA-Z0-9_-]+)\.(jpg|png|webp|jpeg)/i);
        if (baseNameMatch) {
          videoCovers.push(baseNameMatch[1]);
        }
      }
    }

    // ฟังก์ชันทำความสะอาดและคัดกรองลิงก์รูปภาพ: ป้องกันไฟล์ซ้ำ และกรองรูปวิดีโอปกออก
    function cleanAndFilterImages(matches) {
      if (!matches) return [];
      const cleanUrls = matches.map(url => {
        let clean = url.replace(/&amp;/g, '&').replace(/\\u002F/g, '/').replace(/\\/g, '');
        if (clean.startsWith('//')) {
          clean = 'https:' + clean;
        }
        return clean;
      });

      return Array.from(new Set(cleanUrls)).filter(url => {
        if (!url || (!url.startsWith('http') && !url.startsWith('//'))) return false;
        
        // ตรวจสอบคีย์ของรูปภาพเพื่อทำการคัดออกถ้าเป็นภาพวิดีโอปก
        for (const cover of videoCovers) {
          if (url.includes(cover)) {
            return false;
          }
        }
        return true;
      });
    }

    // ─── STEP B: STRATEGY 1 - แกะจาก JSON-LD Product Schema (SEO Data คลีนสุด ไม่มีวิดีโอ) ───
    // Shopee exposes product preview images to social crawlers even when the app
    // shell/API path is blocked by anti-bot checks.
    imageUrls = await scrapeShopeeOpenGraphImages(productUrl);
    imageUrl = imageUrls[0] || '';
    if (!imageUrl) {
      imageUrl = await scrapeShopeeProductImage(finalProductUrl, html);
    }

    const jsonLdReg = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let ldMatch;
    let jsonLdImages = [];

    while ((ldMatch = jsonLdReg.exec(html)) !== null) {
      try {
        const jsonText = ldMatch[1].trim();
        const data = JSON.parse(jsonText);
        const objects = Array.isArray(data) ? data : [data];
        for (const obj of objects) {
          if (obj["@type"] === "Product" || obj["image"]) {
            if (isGenericProductTitle(productTitle) && obj["name"]) {
              productTitle = cleanProductTitle(obj["name"]);
            }
            const imgVal = obj["image"];
            if (Array.isArray(imgVal)) {
              jsonLdImages.push(...imgVal);
            } else if (typeof imgVal === 'string' && imgVal) {
              jsonLdImages.push(imgVal);
            }
          }
        }
      } catch (e) {}
    }

    const filteredJsonLd = cleanAndFilterImages(jsonLdImages);
    if (filteredJsonLd.length > 0) {
      imageUrl = filteredJsonLd.length > 1 ? filteredJsonLd[1] : filteredJsonLd[0];
    }

    // ─── STEP C: STRATEGY 2 - แกะจากแพลตฟอร์ม CDN (Shopee / Lazada) ───
    
    // Shopee CDN
    if (!imageUrl && (finalProductUrl.includes('shopee') || productUrl.includes('shopee') || html.includes('shopee'))) {
      const shopeeCdnReg = /(?:https?:)?(?:\\?\/\\?\/)(?:down-[a-z]{2}|cf)\.img\.susercontent\.com\\?\/file\\?\/[a-zA-Z0-9_-]+/g;
      const shopeeMatches = html.match(shopeeCdnReg);
      const filteredShopee = cleanAndFilterImages(shopeeMatches);
      if (filteredShopee.length > 0) {
        imageUrl = filteredShopee.length > 1 ? filteredShopee[1] : filteredShopee[0];
      }
    }

    // Lazada CDN
    if (!imageUrl && (finalProductUrl.includes('lazada') || productUrl.includes('lazada') || html.includes('lazada'))) {
      const slaticReg = /(\/\/sg-live-[^\s"']+\.slatic\.net\/p\/[^\s"']+)/g;
      const slaticMatches = html.match(slaticReg);
      const filteredSlatic = cleanAndFilterImages(slaticMatches);
      if (filteredSlatic.length > 0) {
        imageUrl = filteredSlatic.length > 1 ? filteredSlatic[1] : filteredSlatic[0];
      }
    }

    // ─── STEP D: STRATEGY 3 - ตรวจสอบ Open Graph และ Twitter ───
    if (!imageUrl) {
      const ogMatches = [];
      const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                           html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
      if (ogImageMatch) ogMatches.push(ogImageMatch[1]);

      const twitterImageMatch = html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);
      if (twitterImageMatch) ogMatches.push(twitterImageMatch[1]);

      const filteredOg = cleanAndFilterImages(ogMatches);
      if (filteredOg.length > 0) {
        imageUrl = filteredOg[0];
      }
    }

    // ทำความสะอาดและแปลง URL ขั้นสุดท้าย
    if (imageUrl) {
      imageUrl = imageUrl.replace(/&amp;/g, '&').replace(/\\u002F/g, '/').replace(/\\/g, '');
      if (imageUrl.startsWith('//')) {
        imageUrl = 'https:' + imageUrl;
      }
    }

    return json({
      success: true,
      title: productTitle || '',
      imageUrl: imageUrl || '',
      imageUrls: imageUrls.length ? imageUrls : (imageUrl ? [imageUrl] : [])
    });

  } catch (err) {
    console.error('Product scraping error:', err);
    return json({ error: err.message || 'Internal Server Error' }, 500);
  }
}

function parseShopeeItemIds(productUrl) {
  const decodedUrl = decodeURIComponent(productUrl || '');
  const patterns = [
    /[?&]shopid=(\d+).*?[?&]itemid=(\d+)/i,
    /\/product\/(\d+)\/(\d+)/i,
    /\/[^/?#]+\/(\d+)\/(\d+)(?:[/?#]|$)/i,
    /(?:^|[.-])i\.(\d+)\.(\d+)(?:\D|$)/i
  ];

  for (const pattern of patterns) {
    const match = decodedUrl.match(pattern);
    if (match) {
      return { shopid: match[1], itemid: match[2] };
    }
  }

  return null;
}

function extractMetaContent(html, propertyName) {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const hasProperty = new RegExp(`\\b(?:property|name)=["']${escaped}["']`, 'i').test(tag);
    if (!hasProperty) continue;

    const contentMatch = tag.match(/\bcontent=["']([^"']+)["']/i);
    if (contentMatch?.[1]) {
      return contentMatch[1]
        .replace(/&amp;/g, '&')
        .replace(/\\u002F/g, '/')
        .replace(/\\/g, '');
    }
  }

  return '';
}

function extractProductTitleFromHtml(html) {
  if (!html) return '';

  const candidates = [
    extractMetaContent(html, 'og:title'),
    extractMetaContent(html, 'twitter:title'),
    extractMetaContent(html, 'title')
  ];

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag?.[1]) candidates.push(titleTag[1]);

  const jsonPatterns = [
    /"productName"\s*:\s*"((?:\\.|[^"\\])*)"/i,
    /"itemName"\s*:\s*"((?:\\.|[^"\\])*)"/i,
    /"name"\s*:\s*"((?:\\.|[^"\\])*)"/i
  ];
  for (const pattern of jsonPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) candidates.push(match[1]);
  }

  for (const candidate of candidates) {
    const title = cleanProductTitle(candidate);
    if (!isGenericProductTitle(title)) return title;
  }

  return '';
}

async function scrapeShopeeOpenGraphTitle(productUrl) {
  if (!productUrl.includes('shopee')) return '';

  try {
    const res = await fetch(productUrl, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    });

    if (!res.ok) return '';
    return extractProductTitleFromHtml(await res.text());
  } catch (e) {
    console.warn('Shopee Open Graph title scrape failed:', e?.message || e);
    return '';
  }
}

async function scrapeShopeeOpenGraphImage(productUrl) {
  const images = await scrapeShopeeOpenGraphImages(productUrl);
  return images[0] || '';
}

async function scrapeShopeeOpenGraphImages(productUrl) {
  if (!productUrl.includes('shopee')) return [];

  try {
    const res = await fetch(productUrl, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    });

    if (!res.ok) return '';
    const html = await res.text();
    const images = extractShopeeProductImagesFromHtml(html);
    if (images.length) return images.slice(0, 10);

    return [
      extractMetaContent(html, 'og:square_image'),
      extractMetaContent(html, 'og:image'),
      extractMetaContent(html, 'twitter:image')
    ].filter(Boolean).slice(0, 10);
  } catch (e) {
    console.warn('Shopee Open Graph scrape failed:', e?.message || e);
    return [];
  }
}

function extractShopeeProductImageFromHtml(html) {
  const images = extractShopeeProductImagesFromHtml(html);
  return images[0] || '';
}

function extractShopeeProductImagesFromHtml(html) {
  const imageReg = /https:\/\/down-[a-z]{2}\.img\.susercontent\.com\/file\/(th-[a-zA-Z0-9_-]+)(?:@[a-zA-Z0-9_]+)?(?:\.webp)?/g;
  const candidates = [];
  let match;

  while ((match = imageReg.exec(html)) !== null) {
    const url = `https://down-th.img.susercontent.com/file/${match[1]}`;
    if (/promo-dim|avatar|icon|logo|badge|mall|default|placeholder/i.test(url)) continue;
    candidates.push(url);
  }

  const uniqueCandidates = Array.from(new Set(candidates));
  const productCandidates = uniqueCandidates.filter(url => !/\/th-111342(?:58|16)-|\/th-11134207-81zt/i.test(url));
  return (productCandidates.length ? productCandidates : uniqueCandidates.slice(1).concat(uniqueCandidates.slice(0, 1))).slice(0, 10);
}

function getShopeeCountryCode(productUrl) {
  try {
    const host = new URL(productUrl).hostname.toLowerCase();
    if (host.endsWith('.co.th')) return 'th';
    if (host.endsWith('.com.my')) return 'my';
    if (host.endsWith('.com.br')) return 'br';
    if (host.endsWith('.com.mx')) return 'mx';
    if (host.endsWith('.com.co')) return 'co';
    if (host.endsWith('.com.ar')) return 'ar';
    if (host.endsWith('.cl')) return 'cl';
    if (host.endsWith('.tw')) return 'tw';
    if (host.endsWith('.vn')) return 'vn';
    if (host.endsWith('.ph')) return 'ph';
    if (host.endsWith('.sg')) return 'sg';
    if (host.endsWith('.co.id')) return 'id';
  } catch (e) {}
  return 'th';
}

function buildShopeeImageUrl(imageId, productUrl) {
  if (!imageId || typeof imageId !== 'string') return '';
  if (imageId.startsWith('http')) return imageId.replace(/\\/g, '');

  const cleanId = imageId
    .replace(/&amp;/g, '&')
    .replace(/\\u002F/g, '/')
    .replace(/\\/g, '')
    .replace(/^\/+file\/+/i, '')
    .trim();

  if (!/^[a-zA-Z0-9_-]+$/.test(cleanId)) return '';
  return `https://down-${getShopeeCountryCode(productUrl)}.img.susercontent.com/file/${cleanId}`;
}

function pickShopeeImageFromData(data, productUrl) {
  const item = data?.data?.item || data?.data || data?.item || data;
  const candidates = [];

  if (Array.isArray(item?.images)) candidates.push(...item.images);
  if (item?.image) candidates.push(item.image);
  if (Array.isArray(item?.tier_variations)) {
    for (const variation of item.tier_variations) {
      if (Array.isArray(variation.images)) candidates.push(...variation.images);
    }
  }
  if (Array.isArray(item?.models)) {
    for (const model of item.models) {
      if (model?.extinfo?.image) candidates.push(model.extinfo.image);
      if (model?.image) candidates.push(model.image);
    }
  }

  for (const candidate of candidates) {
    const imageUrl = buildShopeeImageUrl(candidate, productUrl);
    if (imageUrl) return imageUrl;
  }

  return '';
}

function pickShopeeTitleFromData(data) {
  const item = data?.data?.item || data?.data || data?.item || data;
  return cleanProductTitle(item?.title || item?.name || item?.item_name || '');
}

function pickShopeeImageFromHtml(html, productUrl) {
  const directMatches = html.match(/(?:https?:)?(?:\\?\/\\?\/)(?:down-[a-z]{2}|cf)\.img\.susercontent\.com\\?\/file\\?\/[a-zA-Z0-9_-]+/g);
  if (directMatches?.length) {
    const imageUrl = directMatches[0].replace(/\\\//g, '/');
    return imageUrl.startsWith('//') ? `https:${imageUrl}` : imageUrl;
  }

  const imageIdPatterns = [
    /"images"\s*:\s*\[\s*"([a-zA-Z0-9_-]+)"/,
    /"image"\s*:\s*"([a-zA-Z0-9_-]+)"/,
    /"image_id"\s*:\s*"([a-zA-Z0-9_-]+)"/
  ];

  for (const pattern of imageIdPatterns) {
    const match = html.match(pattern);
    const imageUrl = buildShopeeImageUrl(match?.[1], productUrl);
    if (imageUrl) return imageUrl;
  }

  return '';
}

async function scrapeShopeeProductImage(productUrl, html) {
  if (!productUrl.includes('shopee') && !html.includes('shopee')) return '';

  const ids = parseShopeeItemIds(productUrl);
  if (ids) {
    try {
      const apiUrl = new URL('/api/v4/item/get', productUrl);
      apiUrl.searchParams.set('shopid', ids.shopid);
      apiUrl.searchParams.set('itemid', ids.itemid);

      const apiRes = await fetch(apiUrl.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
          'Referer': productUrl
        }
      });

      if (apiRes.ok) {
        const data = await apiRes.json();
        const imageUrl = pickShopeeImageFromData(data, productUrl);
        if (imageUrl) return imageUrl;
      }
    } catch (e) {
      console.warn('Shopee item API scrape failed:', e?.message || e);
    }
  }

  return pickShopeeImageFromHtml(html, productUrl);
}

async function scrapeShopeeProductTitle(productUrl, html) {
  if (!productUrl.includes('shopee') && !html.includes('shopee')) return '';

  const openGraphTitle = await scrapeShopeeOpenGraphTitle(productUrl);
  if (!isGenericProductTitle(openGraphTitle)) return openGraphTitle;

  const ids = parseShopeeItemIds(productUrl);
  if (ids) {
    try {
      const apiUrl = new URL('/api/v4/item/get', productUrl);
      apiUrl.searchParams.set('shopid', ids.shopid);
      apiUrl.searchParams.set('itemid', ids.itemid);

      const apiRes = await fetch(apiUrl.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
          'Referer': productUrl
        }
      });

      if (apiRes.ok) {
        const data = await apiRes.json();
        const title = pickShopeeTitleFromData(data);
        if (title) return title;
      }
    } catch (e) {
      console.warn('Shopee item API title scrape failed:', e?.message || e);
    }
  }

  return extractProductTitleFromHtml(html);
}
