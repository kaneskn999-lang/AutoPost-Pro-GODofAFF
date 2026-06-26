import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from '../worker/node_modules/ws/index.js';

const PORT = Number(process.env.PORT || 8791);
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

const IMAGE_HOST_RE = /(?:down-[a-z]{2}|cf)\.img\.susercontent\.com/i;

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) req.destroy(new Error('Body too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function exists(file) {
  try {
    const { access } = await import('node:fs/promises');
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  for (const candidate of CHROME_PATHS) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error('Chrome/Edge executable not found');
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function waitForChrome(port, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('Chrome did not open DevTools in time');
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method && listeners.has(msg.method)) {
      for (const listener of listeners.get(msg.method)) listener(msg.params || {});
    }
  });

  return {
    ready: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send(method, params = {}) {
      const messageId = ++id;
      ws.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(messageId, { resolve, reject });
        setTimeout(() => {
          if (!pending.has(messageId)) return;
          pending.delete(messageId);
          reject(new Error(`CDP timeout: ${method}`));
        }, 20000);
      });
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(listener);
    },
    close() {
      ws.close();
    }
  };
}

function normalizeImageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let clean = url
    .replace(/&amp;/g, '&')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '')
    .trim();
  if (clean.startsWith('//')) clean = 'https:' + clean;
  return clean;
}

function scoreImage(url) {
  const clean = normalizeImageUrl(url);
  if (!IMAGE_HOST_RE.test(clean)) return -100;
  let score = 0;
  if (/\/file\//i.test(clean)) score += 50;
  if (/\/[a-f0-9]{24,}/i.test(clean)) score += 20;
  if (/[?&](?:width|height)=\d+/i.test(clean)) score += 5;
  if (/avatar|logo|icon|sprite|rating|voucher|coin|mall|placeholder|default/i.test(clean)) score -= 35;
  if (/60x60|80x80|100x100|_tn|thumbnail/i.test(clean)) score -= 15;
  return score;
}

function pickImage(urls) {
  const ranked = Array.from(new Set(urls.map(normalizeImageUrl).filter(Boolean)))
    .map((url) => ({ url, score: scoreImage(url) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.url || '';
}

async function scrapeShopeeImage(productUrl) {
  const chromePath = await findChrome();
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'shopee-cdp-'));
  const remotePort = 9223 + Math.floor(Math.random() * 300);
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1365,900',
    '--lang=th-TH',
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp;
  try {
    await waitForChrome(remotePort);
    const target = await fetchJson(`http://127.0.0.1:${remotePort}/json/new?about:blank`, { method: 'PUT' });
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.ready;

    const networkUrls = [];
    cdp.on('Network.requestWillBeSent', (params) => {
      const url = params?.request?.url;
      if (url && IMAGE_HOST_RE.test(url)) networkUrls.push(url);
    });
    cdp.on('Network.responseReceived', (params) => {
      const url = params?.response?.url;
      const mime = params?.response?.mimeType || '';
      if (url && (IMAGE_HOST_RE.test(url) || mime.startsWith('image/'))) networkUrls.push(url);
    });

    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Bangkok' });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['th-TH', 'th', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      `
    });
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      acceptLanguage: 'th-TH,th;q=0.9,en;q=0.8',
      platform: 'Windows'
    });

    await cdp.send('Page.navigate', { url: productUrl });
    await new Promise((resolve) => setTimeout(resolve, 9000));

    for (let i = 0; i < 8; i++) {
      await cdp.send('Runtime.evaluate', {
        expression: 'window.scrollBy(0, Math.floor(window.innerHeight * 0.75));',
        returnByValue: true
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const domResult = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const urls = [];
        const push = (value) => { if (value) urls.push(String(value)); };
        document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"]').forEach((el) => push(el.content));
        document.querySelectorAll('img, source').forEach((el) => {
          push(el.currentSrc);
          push(el.src);
          push(el.getAttribute('data-src'));
          push(el.getAttribute('srcset'));
        });
        performance.getEntriesByType('resource').forEach((entry) => push(entry.name));
        const html = document.documentElement.innerHTML;
        const direct = html.match(/(?:https?:)?(?:\\\\?\\/\\\\?\\/)(?:down-[a-z]{2}|cf)\\.img\\.susercontent\\.com\\\\?\\/file\\\\?\\/[a-zA-Z0-9_-]+/g) || [];
        urls.push(...direct);
        return { urls, title: document.title, href: location.href, bodyText: document.body.innerText.slice(0, 800) };
      })()`
    });

    const value = domResult?.result?.value || {};
    const urls = [...networkUrls, ...(value.urls || [])];
    const imageUrl = pickImage(urls);
    return {
      success: Boolean(imageUrl),
      imageUrl,
      finalUrl: value.href || productUrl,
      title: value.title || '',
      candidateCount: Array.from(new Set(urls)).length,
      candidates: Array.from(new Set(urls.map(normalizeImageUrl).filter(Boolean))).slice(0, 20),
      note: imageUrl ? 'Image found from browser network/DOM' : 'No product image found after browser render'
    };
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGKILL');
    setTimeout(() => {
      rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {});
    }, 1000);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });

  if (req.method === 'POST' && req.url === '/scrape') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const productUrl = String(body.url || body.productUrl || '').trim();
      if (!productUrl) return json(res, 400, { success: false, error: 'Missing url' });
      const result = await scrapeShopeeImage(productUrl);
      return json(res, result.success ? 200 : 502, result);
    } catch (err) {
      return json(res, 500, { success: false, error: err.message || String(err) });
    }
  }

  return json(res, 404, { success: false, error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  const script = fileURLToPath(import.meta.url);
  console.log(`Shopee browser scraper listening on http://127.0.0.1:${PORT}`);
  console.log(`Script: ${script}`);
});
