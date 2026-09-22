import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeServer} from '../service.mjs';
import {sampleRecords} from '../sample.mjs';
import {sha256Hex} from '../store.mjs';

export {sha256Hex};

export async function startServer({seedRecords = false, ...opts} = {}) {
 const dir = await mkdtemp(join(tmpdir(), 'seal-test-'));
 const storeDir = join(dir, 'store');
 const recordsPath = join(dir, 'example.json');
 if (seedRecords) await writeFile(recordsPath, JSON.stringify(sampleRecords(), null, 2));
 let server;
 const listen = async () => {
  server = makeServer({storeDir, recordsPath, ...opts});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
 };
 let base = await listen();
 const stop = () => new Promise(r => { server.close(r); server.closeAllConnections?.(); });
 return {
  dir, storeDir, recordsPath,
  get base() { return base; },
  async restart() { await stop(); base = await listen(); },
  async close() { await stop(); await rm(dir, {recursive: true, force: true}); },
 };
}

export async function api(base, method, path, body, headers = {}) {
 const res = await fetch(base + path, {
  method,
  headers: body !== undefined ? {'content-type': 'application/json', ...headers} : headers,
  body: body !== undefined ? JSON.stringify(body) : undefined,
 });
 const text = await res.text();
 let json = null;
 try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
 return {status: res.status, json, text, headers: res.headers};
}

export async function createUpload(base, name, buf, chunkSize, sha256) {
 const res = await api(base, 'POST', '/uploads', {name, size: buf.length, chunk_size: chunkSize, sha256: sha256 ?? sha256Hex(buf)});
 if (res.status !== 201) throw new Error('创建上传会话失败: ' + JSON.stringify(res.json));
 return res.json.upload;
}

export async function putChunk(base, uploadId, index, chunk, digest) {
 const res = await fetch(`${base}/uploads/${uploadId}/chunks/${index}`, {method: 'PUT', headers: {'x-chunk-sha256': digest ?? sha256Hex(chunk)}, body: chunk});
 return {status: res.status, json: await res.json()};
}

export function splitChunks(buf, chunkSize) {
 const chunks = [];
 for (let i = 0; i < buf.length; i += chunkSize) chunks.push(buf.subarray(i, i + chunkSize));
 return chunks;
}

export async function uploadFile(base, name, buf, {chunkSize = 65536, order} = {}) {
 const upload = await createUpload(base, name, buf, chunkSize);
 const chunks = splitChunks(buf, chunkSize);
 for (const i of order ?? chunks.map((_, i) => i)) {
  const r = await putChunk(base, upload.upload_id, i, chunks[i]);
  if (r.status !== 200) throw new Error(`分块 ${i} 上传失败: ` + JSON.stringify(r.json));
 }
 const done = await api(base, 'POST', `/uploads/${upload.upload_id}/complete`);
 if (done.status !== 200) throw new Error('合并失败: ' + JSON.stringify(done.json));
 return {upload, file: done.json.file, chunks};
}
