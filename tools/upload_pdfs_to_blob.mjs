#!/usr/bin/env node
/**
 * 把 books/manifest.json 中本地 pdfUrl 引用的 PDF 上传到 EdgeOne Blob，
 * 上传成功后客户端通过 edge-functions/api/pdf.js 以 pdfKey 方式读取。
 *
 * 用法：
 *   EDGEONE_PAGES_PROJECT_ID=pages-xxx EDGEONE_PAGES_TOKEN=xxx \
 *     node tools/upload_pdfs_to_blob.mjs [--dry-run] [--force]
 *
 *   --dry-run  只打印将要上传的 key 和本地文件，不上传
 *   --force    已存在的 key 也重新上传（默认跳过）
 *
 * key 规则：books/<bookId>/<file>.pdf -> pdfs/<bookId>/<file>.pdf
 * Token 申请：https://pages.edgeone.ai/document/api-token
 */
import { readFile, stat } from 'node:fs/promises';
import { getStore } from '@edgeone/pages-blob';

const STORE_NAME = 'tranquil-reader-pdfs';
const KEY_PREFIX = 'pdfs/';
const CONCURRENCY = 3;

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');

function collectPdfSources(manifest) {
  const sources = [];
  for (const book of manifest.books || []) {
    const push = (source, label) => {
      if (!source || typeof source !== 'object') return;
      if (typeof source.pdfKey === 'string' && source.pdfKey.trim()) return; // 已迁移
      const pdfUrl = typeof source.pdfUrl === 'string' ? source.pdfUrl.trim() : '';
      if (!pdfUrl || /^(https?:)?\/\//.test(pdfUrl)) return; // 外部 URL 无需上传
      if (!pdfUrl.toLowerCase().endsWith('.pdf')) return;
      const rel = pdfUrl.replace(/^\/+/, '');
      const bookPrefix = `books/${book.id}/`;
      if (!rel.startsWith(bookPrefix)) {
        throw new Error(`${label}: pdfUrl "${rel}" 不在 ${bookPrefix} 下，无法推导 pdfKey`);
      }
      sources.push({ label, localPath: rel, key: KEY_PREFIX + rel.slice('books/'.length) });
    };
    push(book, `${book.id}`);
    (book.parts || []).forEach((part, i) => push(part, `${book.id} parts[${i}]`));
  }
  return sources;
}

async function main() {
  const manifest = JSON.parse(await readFile('books/manifest.json', 'utf8'));
  const sources = collectPdfSources(manifest);
  if (!sources.length) {
    console.log('manifest.json 中没有待上传的本地 pdfUrl，无需操作。');
    return;
  }

  let totalBytes = 0;
  for (const s of sources) totalBytes += (await stat(s.localPath)).size;
  const totalMB = totalBytes / 1048576;
  console.log(`共 ${sources.length} 个 PDF，约 ${totalMB.toFixed(1)} MB。`);

  if (dryRun) {
    for (const s of sources) console.log(`${s.localPath} -> ${s.key}`);
    console.log('dry-run，未上传。');
    return;
  }

  const { EDGEONE_PAGES_PROJECT_ID, EDGEONE_PAGES_TOKEN } = process.env;
  if (!EDGEONE_PAGES_PROJECT_ID || !EDGEONE_PAGES_TOKEN) {
    console.error('缺少环境变量 EDGEONE_PAGES_PROJECT_ID / EDGEONE_PAGES_TOKEN。');
    console.error('Token 申请：https://pages.edgeone.ai/document/api-token');
    process.exit(1);
  }

  const store = getStore({ name: STORE_NAME, projectId: EDGEONE_PAGES_PROJECT_ID, token: EDGEONE_PAGES_TOKEN });

  let existing = new Set();
  if (!force) {
    const { blobs } = await store.list({ prefix: KEY_PREFIX });
    existing = new Set(blobs.map((b) => b.key));
  }

  const pending = sources.filter((s) => force || !existing.has(s.key));
  console.log(`跳过已存在 ${sources.length - pending.length} 个，待上传 ${pending.length} 个。`);

  let done = 0;
  const failed = [];
  async function uploadOne(s) {
    try {
      const data = await readFile(s.localPath);
      await store.set(s.key, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      done += 1;
      console.log(`[${done}/${pending.length}] ${s.key} (${(data.length / 1048576).toFixed(1)} MB)`);
    } catch (err) {
      failed.push({ key: s.key, err });
      console.error(`失败 ${s.key}: ${err && err.message ? err.message : err}`);
    }
  }

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    await Promise.all(pending.slice(i, i + CONCURRENCY).map(uploadOne));
  }

  if (failed.length) {
    console.error(`${failed.length} 个文件上传失败，重跑本脚本即可续传。`);
    process.exit(1);
  }
  console.log('全部上传完成。');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
