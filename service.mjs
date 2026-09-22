import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {readRecords, validateUploadRequest, validateSealRequest, validateReviewRequest, validateWithdrawalRequest, validateGrantRequest, SHA256_RE} from './contracts.mjs';
import {Store} from './store.mjs';
import {HttpError} from './errors.mjs';

const JSON_LIMIT = 1024 * 1024;
const CHUNK_LIMIT = 64 * 1024 * 1024;

async function readBody(req, limit) {
 const parts = [];
 let total = 0;
 for await (const part of req) {
  total += part.length;
  if (total > limit) throw new HttpError(413, 'BODY_TOO_LARGE', '请求体超出大小限制');
  parts.push(part);
 }
 return Buffer.concat(parts);
}

async function readJson(req) {
 const buf = await readBody(req, JSON_LIMIT);
 if (!buf.length) throw new HttpError(400, 'BODY_EMPTY', '请求体不能为空');
 try { return JSON.parse(buf.toString('utf8')); }
 catch { throw new HttpError(400, 'JSON_INVALID', '请求体不是合法 JSON'); }
}

function publicUpload(meta) {
 const missing = [];
 if (meta.status === 'receiving') for (let i = 0; i < meta.chunk_count; i++) if (!meta.received.includes(i)) missing.push(i);
 return {
  upload_id: meta.upload_id, name: meta.name, size: meta.size, chunk_size: meta.chunk_size,
  chunk_count: meta.chunk_count, sha256: meta.sha256, status: meta.status,
  received: meta.received, missing, ...(meta.failure ? {failure: meta.failure} : {}),
 };
}

function compile(path) {
 const keys = [];
 const re = new RegExp('^' + path.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
 return {re, keys};
}

export function makeServer({storeDir = 'data/store', recordsPath = 'data/example.json', now, hooks} = {}) {
 const store = new Store(storeDir, {now, hooks});

 async function loadRecords() {
  try { return await readRecords(recordsPath); }
  catch (e) {
   if (e && e.code === 'ENOENT') throw new HttpError(404, 'RECORDS_MISSING', '样例数据不存在，请先运行 npm run seed');
   throw e;
  }
 }

 const routes = [
  ['GET', '/health', async () => ({body: {status: 'ok'}})],
  ['GET', '/records', async () => ({body: {records: await loadRecords()}})],
  ['POST', '/uploads', async (req) => ({status: 201, body: {upload: publicUpload(await store.createUpload(validateUploadRequest(await readJson(req))))}})],
  ['GET', '/uploads/:id', async (req, p) => ({body: {upload: publicUpload(await store.uploadStatus(p.id))}})],
  ['PUT', '/uploads/:id/chunks/:index', async (req, p) => {
   const index = Number(p.index);
   if (!Number.isInteger(index) || index < 0) throw new HttpError(400, 'CHUNK_INDEX_INVALID', '分块序号不是有效整数');
   const digest = req.headers['x-chunk-sha256'];
   if (!SHA256_RE.test(String(digest ?? ''))) throw new HttpError(400, 'CHUNK_DIGEST_REQUIRED', '缺少合法的 x-chunk-sha256 请求头');
   const body = await readBody(req, CHUNK_LIMIT);
   return {body: {result: await store.uploadChunk(p.id, index, body, digest)}};
  }],
  ['POST', '/uploads/:id/complete', async (req, p) => {
   const {file} = await store.completeUpload(p.id);
   return {body: {file}};
  }],
  ['POST', '/packages', async (req) => {
   const input = validateSealRequest(await readJson(req));
   let record_linked = false;
   try {
    const rec = (await loadRecords()).find(r => r.measure_id === input.measure_id);
    if (rec) { input.site = rec.site; input.capture_at = rec.capture_at; record_linked = true; }
   } catch (e) { if (!(e instanceof HttpError && e.code === 'RECORDS_MISSING')) throw e; }
   if (!record_linked && (!input.site || !input.capture_at)) throw new HttpError(400, 'SITE_REQUIRED', '措施不在样例记录中时，必须提供 site 与 capture_at');
   const result = await store.seal(input);
   return {status: result.idempotent ? 200 : 201, body: {...result, record_linked}};
  }],
  ['GET', '/packages', async (req, p, q) => ({body: {packages: await store.listPackages(q.get('measure_id') ?? undefined)}})],
  ['GET', '/packages/:id', async (req, p) => {
   const manifest = await store.getPackage(p.id);
   return {body: {manifest, versions: await store.versionsOf(manifest.measure_id)}};
  }],
  ['GET', '/packages/:id/verify', async (req, p) => ({body: await store.verifyPackage(p.id)})],
  ['POST', '/packages/:id/withdrawals', async (req, p) => ({status: 201, body: {withdrawal: await store.addWithdrawal(p.id, validateWithdrawalRequest(await readJson(req)))}})],
  ['GET', '/packages/:id/withdrawals', async (req, p) => ({body: {withdrawals: await store.listWithdrawals(p.id)}})],
  ['POST', '/packages/:id/grants', async (req, p) => {
   const {file, ttl_seconds} = validateGrantRequest(await readJson(req));
   const grant = await store.issueGrant(p.id, file, ttl_seconds);
   return {status: 201, body: {...grant, download_url: `/download/${grant.token}`}};
  }],
  ['POST', '/reviews', async (req) => ({status: 201, body: {review: await store.addReview(validateReviewRequest(await readJson(req)))}})],
  ['GET', '/packages/:id/versions/:version/reviews', async (req, p) => {
   const version = Number(p.version);
   if (!Number.isInteger(version) || version < 1) throw new HttpError(400, 'VERSION_INVALID', '版本号不是有效整数');
   return {body: {reviews: await store.listReviews(p.id, version)}};
  }],
  ['GET', '/download/:token', async (req, p) => {
   const grant = await store.resolveGrant(p.token);
   const {buf, entry} = await store.readPackageFileVerified(grant.package_id, grant.file);
   return {
    buffer: buf,
    headers: {
     'Content-Type': 'application/octet-stream',
     'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
     'X-Content-SHA256': entry.sha256,
     'Cache-Control': 'no-store',
    },
   };
  }],
 ].map(([method, path, handler]) => ({method, handler, ...compile(path)}));

 return createServer(async (req, res) => {
  const sendJson = (status, obj) => {
   res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
   res.end(JSON.stringify(obj));
  };
  try {
   const url = new URL(req.url ?? '/', 'http://internal');
   let pathMatched = false;
   for (const r of routes) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    if (r.method !== req.method) { pathMatched = true; continue; }
    const params = {};
    r.keys.forEach((k, i) => {
     try { params[k] = decodeURIComponent(m[i + 1]); }
     catch { throw new HttpError(400, 'PATH_INVALID', '路径编码不合法'); }
    });
    const out = await r.handler(req, params, url.searchParams);
    if (out && out.buffer) {
     res.writeHead(out.status ?? 200, out.headers);
     res.end(out.buffer);
    } else {
     sendJson(out?.status ?? 200, out?.body ?? {});
    }
    return;
   }
   if (pathMatched) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '该资源不支持此操作；已封存的证据包不可改写');
   throw new HttpError(404, 'NOT_FOUND', '接口不存在');
  } catch (e) {
   if (e instanceof HttpError) {
    sendJson(e.status, {error: {code: e.code, message: e.message, ...(e.details === undefined ? {} : {details: e.details})}});
   } else {
    console.error(e);
    sendJson(500, {error: {code: 'INTERNAL', message: '服务内部错误'}});
   }
  }
 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 makeServer().listen(Number(process.env.PORT || 8080), '0.0.0.0');
}
