const STORE_PREFIX = 'reader_progress_';
const MAX_BODY_BYTES = 32 * 1024;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export async function onRequest({ request }) {
  return handleRequest(request);
}

async function handleRequest(request) {
  if (request.method === 'OPTIONS') return json({ ok: true });

  try {
    if (typeof KV === 'undefined' || !KV) {
      return json({ ok: false, error: 'KV is not available' }, 500);
    }

    const url = new URL(request.url);

    if (request.method === 'GET') {
      const code = normalizeCode(url.searchParams.get('code'));
      if (!code) return json({ ok: false, error: '请输入有效同步码' }, 400);

      const record = await readRecord(code);
      if (!record) return json({ ok: false, error: '没有找到这个同步码的进度' }, 404);

      return json({
        ok: true,
        code,
        updatedAt: record.updatedAt || null,
        progress: record.progress || {},
        lastProgress: record.lastProgress || null,
      });
    }

    if (request.method === 'POST' || request.method === 'PUT') {
      const body = await readJsonBody(request);
      const code = normalizeCode(body && body.code);
      if (!code) return json({ ok: false, error: '请输入有效同步码' }, 400);

      const progress = sanitizeProgressMap(body && body.progress);
      const lastProgress = sanitizeLastProgress(body && body.lastProgress, progress);

      if (!Object.keys(progress).length) {
        return json({ ok: false, error: '没有可保存的阅读进度' }, 400);
      }

      const record = {
        version: 1,
        updatedAt: Date.now(),
        progress,
        lastProgress,
      };

      await writeRecord(code, record);

      return json({
        ok: true,
        code,
        updatedAt: record.updatedAt,
        count: Object.keys(progress).length,
      });
    }

    return json({ ok: false, error: 'Method not allowed' }, 405, {
      allow: 'GET, POST, PUT, OPTIONS',
    });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err || '同步失败') }, 500);
  }
}

function normalizeCode(value) {
  const code = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_]{3,31}$/.test(code)) return '';
  return code;
}

async function readJsonBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('请求内容过大');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error('请求 JSON 无效');
  }
}

function sanitizeProgressMap(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;

  for (const [bookId, value] of Object.entries(input)) {
    const safeBookId = String(bookId || '').trim();
    if (!/^[\w.-]{1,80}$/.test(safeBookId)) continue;

    const progress = sanitizeProgress(value);
    if (progress) out[safeBookId] = progress;
  }

  return out;
}

function sanitizeLastProgress(input, progressMap) {
  if (!input || typeof input !== 'object') return null;

  const book = String(input.book || '').trim();
  if (!book || !progressMap[book]) return null;

  return {
    book,
    ...progressMap[book],
  };
}

function sanitizeProgress(value) {
  if (!value || typeof value !== 'object') return null;

  const chapter = toNonNegativeInteger(value.chapter);
  const para = toNonNegativeInteger(value.para);
  const scroll = toNonNegativeNumber(value.scroll);
  const time = toNonNegativeNumber(value.time) || Date.now();

  if (chapter === null) return null;

  return {
    chapter,
    para: para === null ? 0 : para,
    scroll: scroll === null ? 0 : scroll,
    time,
  };
}

function toNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  return number;
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

async function readRecord(code) {
  const raw = await kvGet(progressKey(code));
  if (!raw) return null;

  if (typeof raw === 'object') return raw;

  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

async function writeRecord(code, record) {
  await kvPut(progressKey(code), JSON.stringify(record));
}

function progressKey(code) {
  return STORE_PREFIX + code;
}

async function kvGet(key) {
  if (typeof KV.get === 'function') return KV.get(key);
  if (typeof KV.getItem === 'function') return KV.getItem(key);
  throw new Error('KV.get is not available');
}

async function kvPut(key, value) {
  if (typeof KV.put === 'function') return KV.put(key, value);
  if (typeof KV.set === 'function') return KV.set(key, value);
  if (typeof KV.setItem === 'function') return KV.setItem(key, value);
  throw new Error('KV.put is not available');
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders,
    },
  });
}
