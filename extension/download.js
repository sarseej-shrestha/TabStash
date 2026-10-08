import { MAX_FILE_BYTES } from './storage.js';

export function downloadOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only direct HTTP(S) links without embedded credentials are supported. Download normally, then use Add files.');
  }
  return `${url.origin}/*`;
}

export function downloadName(url, disposition = '') {
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="([^"]+)"|filename=([^;]+)/i);
  let name = encoded || plain?.[1] || plain?.[2] || new URL(url).pathname.split('/').pop() || 'download';
  try { name = decodeURIComponent(name); } catch { /* Keep literal name on malformed escaping. */ }
  return name.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim().slice(0, 255) || 'download';
}

export async function fetchDirectFile(url, fetcher = fetch) {
  downloadOrigin(url);
  const response = await fetcher(url, {
    method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    cache: 'no-store', signal: AbortSignal.timeout(25_000),
  });
  const rejectResponse = async message => {
    await response.body?.cancel().catch(() => {});
    throw new Error(message);
  };
  if (!response.ok) return rejectResponse(`Download returned HTTP ${response.status}. Download normally, then use Add files.`);
  const type = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  if (['text/html', 'application/xhtml+xml'].includes(type)) return rejectResponse('The link returned a web page. Download the actual file normally, then use Add files.');
  if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) return rejectResponse('This file exceeds the 20 MiB limit.');
  if (!response.body) throw new Error('The link returned no file content. Use Add files instead.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) throw new Error('This file exceeds the 20 MiB limit.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return { blob: new Blob(chunks, { type }), name: downloadName(url, response.headers.get('content-disposition') || '') };
}
