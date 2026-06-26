import { getStore } from '@edgeone/pages-blob';

const STORE_NAME = 'tranquil-reader-pdfs';
const KEY_PREFIX = 'pdfs/';

export async function onRequest({ request }) {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD' },
      });
    }

    const url = new URL(request.url);
    const key = normalizePdfKey(url.searchParams.get('key'));
    if (!key) return new Response('Invalid PDF key', { status: 400 });

    const store = getStore(STORE_NAME);
    const result = await store.getWithHeaders(key);
    if (!result) return new Response('PDF not found', { status: 404 });

    const headers = new Headers(result.headers || {});
    headers.set('content-type', 'application/pdf');
    headers.set('content-disposition', `inline; filename="${encodeURIComponent(key.split('/').pop() || 'book.pdf')}"`);
    headers.set('cache-control', headers.get('cache-control') || 'public, max-age=86400');
    headers.set('x-content-type-options', 'nosniff');

    return new Response(request.method === 'HEAD' ? null : result.body, {
      status: 200,
      headers,
    });
  } catch (err) {
    return new Response(String((err && err.message) || err || 'PDF load failed'), { status: 500 });
  }
}

function normalizePdfKey(value) {
  const key = String(value || '').trim().replace(/^\/+/, '');
  if (!key || key.length > 240) return '';
  if (!key.startsWith(KEY_PREFIX)) return '';
  if (!/\.pdf$/i.test(key)) return '';
  if (key.includes('..') || key.includes('\\')) return '';
  if (!/^[A-Za-z0-9/_ .-]+$/.test(key)) return '';
  return key;
}
