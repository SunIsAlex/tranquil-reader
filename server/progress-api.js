/* ============================================================
   静读 · 阅读进度同步 API（VPS 自托管版）
   移植自原 EdgeOne edge-functions/api/progress.js，
   KV 存储替换为本地 JSON 文件（sha256(同步码).json，临时文件 + rename 原子写入）。
   零依赖：仅使用 Node.js 内置模块，监听 127.0.0.1，由 nginx 反代 /api/progress。
   ============================================================ */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || '/var/lib/reader-sync';
const API_PATH = '/api/progress';

const MAX_BODY_BYTES = 128 * 1024;
const MAX_BOOKMARKS_PER_BOOK = 200;
const MAX_BOOKMARKS_TOTAL = 1000;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

fs.mkdirSync(DATA_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== API_PATH) {
      return json(res, { ok: false, error: 'Not found' }, 404);
    }

    if (req.method === 'OPTIONS') return json(res, { ok: true });

    if (req.method === 'GET') {
      const code = normalizeCode(url.searchParams.get('code'));
      if (!code) return json(res, { ok: false, error: '请输入有效同步码' }, 400);

      const record = readRecord(code);
      if (!record) return json(res, { ok: false, error: '没有找到这个同步码的进度' }, 404);

      return json(res, {
        ok: true,
        code,
        updatedAt: record.updatedAt || null,
        progress: record.progress || {},
        lastProgress: record.lastProgress || null,
        bookmarks: record.bookmarks || {},
      });
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const body = await readJsonBody(req);
      const code = normalizeCode(body && body.code);
      if (!code) return json(res, { ok: false, error: '请输入有效同步码' }, 400);

      const progress = sanitizeProgressMap(body && body.progress);
      const lastProgress = sanitizeLastProgress(body && body.lastProgress, progress);
      const hasBookmarkPayload = Object.prototype.hasOwnProperty.call(body || {}, 'bookmarks');
      const previousRecord = hasBookmarkPayload ? null : readRecord(code);
      const bookmarks = sanitizeBookmarkMap(
        hasBookmarkPayload ? body.bookmarks : previousRecord && previousRecord.bookmarks
      );

      if (!Object.keys(progress).length) {
        return json(res, { ok: false, error: '没有可保存的阅读进度' }, 400);
      }

      const record = {
        version: 2,
        updatedAt: Date.now(),
        progress,
        lastProgress,
        bookmarks,
      };

      writeRecord(code, record);

      return json(res, {
        ok: true,
        code,
        updatedAt: record.updatedAt,
        count: Object.keys(progress).length,
        bookmarkCount: countBookmarks(bookmarks),
      });
    }

    return json(res, { ok: false, error: 'Method not allowed' }, 405, {
      allow: 'GET, POST, PUT, OPTIONS',
    });
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 500;
    return json(res, { ok: false, error: String((err && err.message) || err || '同步失败') }, status);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`reader-sync listening on http://${HOST}:${PORT}${API_PATH}, data dir: ${DATA_DIR}`);
});

/* ---------- 同步码与存储 ---------- */

function normalizeCode(value) {
  const code = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_]{3,31}$/.test(code)) return '';
  return code;
}

// 文件名用同步码的 sha256，避免路径注入，也不落盘明文同步码。
function recordPath(code) {
  const digest = crypto.createHash('sha256').update(code).digest('hex');
  return path.join(DATA_DIR, `${digest}.json`);
}

function readRecord(code) {
  try {
    const raw = fs.readFileSync(recordPath(code), 'utf8');
    const record = JSON.parse(raw);
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

function writeRecord(code, record) {
  const target = recordPath(code);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
  fs.renameSync(tmp, target);
}

/* ---------- 请求体 ---------- */

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求内容过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('请求 JSON 无效'), { statusCode: 400 }));
      }
    });
    req.on('error', () => reject(Object.assign(new Error('请求读取失败'), { statusCode: 400 })));
  });
}

/* ---------- 数据清洗（与原 edge function 一致） ---------- */

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

function sanitizeBookmarkMap(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;

  let total = 0;
  for (const [bookId, value] of Object.entries(input)) {
    if (total >= MAX_BOOKMARKS_TOTAL) break;
    const safeBookId = String(bookId || '').trim();
    if (!/^[\w.-]{1,80}$/.test(safeBookId) || !Array.isArray(value)) continue;

    const items = [];
    for (const bookmark of value.slice(0, MAX_BOOKMARKS_PER_BOOK)) {
      if (total >= MAX_BOOKMARKS_TOTAL) break;
      const normalized = sanitizeBookmark(bookmark);
      if (!normalized) continue;
      items.push(normalized);
      total += 1;
    }
    out[safeBookId] = items;
  }

  return out;
}

function sanitizeBookmark(value) {
  if (!value || typeof value !== 'object') return null;
  const chapter = toNonNegativeInteger(value.chapter);
  const para = toNonNegativeInteger(value.para);
  if (chapter === null || para === null) return null;

  const fallbackId = `${chapter}:${para}`;
  return {
    id: String(value.id || fallbackId).slice(0, 120),
    chapter,
    para,
    note: String(value.note || '').slice(0, 2000),
    excerpt: String(value.excerpt || '').slice(0, 500),
    createdAt: toNonNegativeNumber(value.createdAt) || Date.now(),
    updatedAt: value.updatedAt == null ? null : toNonNegativeNumber(value.updatedAt),
  };
}

function countBookmarks(bookmarkMap) {
  return Object.values(bookmarkMap)
    .reduce((total, items) => total + items.length, 0);
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

function json(res, payload, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  res.end(body);
}
