import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {HttpError} from './errors.mjs';

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

// 稳定序列化：对象键排序，同一内容永远得到同一字节串，作为包摘要输入。
export function canonicalize(value) {
 if (value === null || typeof value !== 'object') return JSON.stringify(value);
 if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
 return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// 清单核心字段：措施、现场记录、文件摘要的关联即证据包本体；文件按名称排序保证幂等。
export function manifestCore(input) {
 const files = [...input.files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
 return {
  format: 'evidence-package/1',
  measure_id: input.measure_id,
  site: input.site,
  capture_at: input.capture_at,
  note: input.note ?? null,
  submitted_by: input.submitted_by,
  version: input.version,
  previous: input.previous,
  files: files.map(f => ({name: f.name, sha256: f.sha256, size: f.size})),
 };
}

export function packageIdOf(digest) { return 'pkg_' + digest.slice(0, 24); }

const idRe = (prefix) => new RegExp(`^${prefix}_[0-9a-f]{24}$`);

async function readJsonl(path) {
 let text;
 try { text = await readFile(path, 'utf8'); } catch { return []; }
 const lines = text.split('\n').filter(line => line.trim());
 const rows = [];
 for (let i = 0; i < lines.length; i++) {
  try { rows.push(JSON.parse(lines[i])); }
  catch {
   if (i === lines.length - 1) break; // 进程中断留下的半行，丢弃
   throw new Error(`日志文件损坏: ${path} 第 ${i + 1} 行`);
  }
 }
 return rows;
}

export class Store {
 constructor(root, {now = () => Date.now(), hooks = {}} = {}) {
  this.root = root;
  this.now = now;
  this.hooks = hooks;
  this.dirs = {
   stagingUploads: join(root, 'staging', 'uploads'),
   stagingSeal: join(root, 'staging', 'seal'),
   blobs: join(root, 'blobs'),
   packages: join(root, 'packages'),
  };
  this.registryPath = join(root, 'registry.jsonl');
  this.reviewsPath = join(root, 'reviews.jsonl');
  this.withdrawalsPath = join(root, 'withdrawals.jsonl');
  this.grantsPath = join(root, 'grants.json');
  this.secretPath = join(root, 'secret.key');
  this.registry = new Map();
  this.byMeasure = new Map();
  this.byContent = new Map();
  this.reviews = [];
  this.withdrawals = [];
  this.grants = new Map();
  this._queue = Promise.resolve();
  this._init = null;
 }

 // 串行化所有写操作，避免并发写坏日志与清单。
 #enqueue(task) {
  const run = this._queue.then(task, task);
  this._queue = run.then(() => {}, () => {});
  return run;
 }

 async init() {
  if (!this._init) this._init = this.#boot();
  return this._init;
 }

 async #boot() {
  for (const dir of Object.values(this.dirs)) await mkdir(dir, {recursive: true});
  try {
   this.secret = (await readFile(this.secretPath, 'utf8')).trim();
  } catch {
   this.secret = randomBytes(32).toString('hex');
   await writeFile(this.secretPath, this.secret + '\n', {mode: 0o600});
  }
  for (const e of await readJsonl(this.registryPath)) {
   this.registry.set(e.package_id, e);
   const arr = this.byMeasure.get(e.measure_id) ?? [];
   arr.push(e.package_id);
   this.byMeasure.set(e.measure_id, arr);
   this.byContent.set(e.content_key, e.package_id);
  }
  this.reviews = await readJsonl(this.reviewsPath);
  this.withdrawals = await readJsonl(this.withdrawalsPath);
  try {
   this.grants = new Map(Object.entries(JSON.parse(await readFile(this.grantsPath, 'utf8'))));
  } catch (e) {
   if (e.code !== 'ENOENT') throw new Error(`授权记录损坏: ${this.grantsPath}`);
   this.grants = new Map();
  }
  // 启动清扫：未登记的包目录与封存暂存目录都是中断残留，删除前从未对外可见。
  const swept = [];
  for (const name of await readdir(this.dirs.packages)) {
   if (!this.registry.has(name)) {
    await rm(join(this.dirs.packages, name), {recursive: true, force: true});
    swept.push(name);
   }
  }
  for (const name of await readdir(this.dirs.stagingSeal)) {
   await rm(join(this.dirs.stagingSeal, name), {recursive: true, force: true});
   swept.push('staging:' + name);
  }
  return {swept};
 }

 // ---- 分块上传 ----

 async createUpload(input) {
  return this.#enqueue(async () => {
   await this.init();
   const id = 'upl_' + randomBytes(12).toString('hex');
   const meta = {
    upload_id: id,
    name: input.name,
    size: input.size,
    chunk_size: input.chunk_size,
    sha256: input.sha256,
    chunk_count: Math.ceil(input.size / input.chunk_size),
    status: 'receiving',
    received: [],
    chunk_digests: {},
    created_at: new Date(this.now()).toISOString(),
   };
   const dir = join(this.dirs.stagingUploads, id);
   await mkdir(join(dir, 'chunks'), {recursive: true});
   await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
   return meta;
  });
 }

 async #loadUpload(id) {
  if (!idRe('upl').test(String(id))) throw new HttpError(404, 'UPLOAD_NOT_FOUND', '上传会话不存在');
  const dir = join(this.dirs.stagingUploads, id);
  try {
   return {dir, meta: JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))};
  } catch {
   throw new HttpError(404, 'UPLOAD_NOT_FOUND', '上传会话不存在');
  }
 }

 async #saveUpload(dir, meta) {
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
 }

 async uploadChunk(id, index, body, chunkSha256) {
  return this.#enqueue(async () => {
   await this.init();
   const {dir, meta} = await this.#loadUpload(id);
   if (meta.status !== 'receiving') throw new HttpError(409, 'UPLOAD_CLOSED', `上传会话已${meta.status === 'completed' ? '完成' : '失败关闭'}，不能继续传分块`);
   if (!Number.isInteger(index) || index < 0 || index >= meta.chunk_count) throw new HttpError(400, 'CHUNK_INDEX_INVALID', '分块序号超出范围', {index, chunk_count: meta.chunk_count});
   const isLast = index === meta.chunk_count - 1;
   const expectSize = isLast ? meta.size - meta.chunk_size * (meta.chunk_count - 1) : meta.chunk_size;
   if (body.length !== expectSize) throw new HttpError(400, 'CHUNK_SIZE_MISMATCH', '分块长度与约定不符', {expected: expectSize, actual: body.length});
   const actual = sha256Hex(body);
   if (actual !== chunkSha256) throw new HttpError(422, 'CHUNK_DIGEST_MISMATCH', '分块摘要与校验值不符，分块未保存', {declared: chunkSha256, actual});
   const path = join(dir, 'chunks', String(index));
   let existing = null;
   try { existing = await readFile(path); } catch { /* 尚未上传 */ }
   if (existing) {
    if (sha256Hex(existing) !== actual) throw new HttpError(409, 'CHUNK_CONFLICT', '同一序号的分块内容不一致，已保留先到的分块', {index});
    if (!meta.received.includes(index)) { // 崩溃恢复：文件在、登记缺失，补登记
     meta.received.push(index);
     meta.received.sort((a, b) => a - b);
     meta.chunk_digests[index] = actual;
     await this.#saveUpload(dir, meta);
    }
    return {status: 'duplicate', index, received: meta.received};
   }
   await writeFile(path, body);
   meta.received.push(index);
   meta.received.sort((a, b) => a - b);
   meta.chunk_digests[index] = actual;
   await this.#saveUpload(dir, meta);
   return {status: 'stored', index, received: meta.received};
  });
 }

 async uploadStatus(id) {
  await this.init();
  const {meta} = await this.#loadUpload(id);
  return meta;
 }

 async completeUpload(id) {
  return this.#enqueue(async () => {
   await this.init();
   const {dir, meta} = await this.#loadUpload(id);
   if (meta.status === 'completed') return {file: {name: meta.name, sha256: meta.sha256, size: meta.size}, meta};
   if (meta.status !== 'receiving') throw new HttpError(409, 'UPLOAD_FAILED', '上传会话已失败关闭，需重新发起上传', {failure: meta.failure});
   const missing = [];
   for (let i = 0; i < meta.chunk_count; i++) if (!meta.received.includes(i)) missing.push(i);
   if (missing.length) throw new HttpError(409, 'CHUNKS_MISSING', '分块未传齐，不能合并', {missing});
   const bufs = [];
   for (let i = 0; i < meta.chunk_count; i++) {
    let buf;
    try { buf = await readFile(join(dir, 'chunks', String(i))); }
    catch { throw new HttpError(409, 'CHUNKS_MISSING', '分块文件缺失，请重新上传该分块', {missing: [i]}); }
    if (sha256Hex(buf) !== meta.chunk_digests[i]) throw new HttpError(422, 'CHUNK_CORRUPT', '暂存分块已损坏，请重新上传该分块', {index: i});
    bufs.push(buf);
   }
   const whole = Buffer.concat(bufs);
   const actual = sha256Hex(whole);
   if (actual !== meta.sha256) {
    meta.status = 'failed';
    meta.failure = {reason: '整包摘要不符', declared: meta.sha256, actual};
    await this.#saveUpload(dir, meta);
    throw new HttpError(422, 'PACKAGE_DIGEST_MISMATCH', '整包摘要不符，合并结果已废弃，未生成任何证据内容', {declared: meta.sha256, actual});
   }
   const blobPath = join(this.dirs.blobs, actual);
   let reused = true;
   try { await stat(blobPath); }
   catch {
    reused = false;
    const tmp = join(this.dirs.blobs, '.tmp-' + randomBytes(8).toString('hex'));
    await writeFile(tmp, whole);
    await rename(tmp, blobPath);
   }
   meta.status = 'completed';
   await this.#saveUpload(dir, meta);
   await rm(join(dir, 'chunks'), {recursive: true, force: true});
   return {file: {name: meta.name, sha256: actual, size: meta.size}, reused, meta};
  });
 }

 // ---- 封存 ----

 async seal(input) {
  return this.#enqueue(async () => {
   await this.init();
   for (const f of input.files) {
    const blobPath = join(this.dirs.blobs, f.sha256);
    let buf;
    try { buf = await readFile(blobPath); }
    catch { throw new HttpError(422, 'BLOB_MISSING', `文件 ${f.name} 尚未完成上传`, {file: f.name, sha256: f.sha256}); }
    if (buf.length !== f.size || sha256Hex(buf) !== f.sha256) throw new HttpError(422, 'BLOB_CORRUPT', `已上传内容 ${f.name} 与声明摘要不符，拒绝封存`, {file: f.name});
   }
   // 内容键不含版本号：内容完全相同的重复送审幂等返回原包，任何变化才生成新版本。
   const content_key = sha256Hex(Buffer.from(canonicalize(manifestCore({...input, version: 0, previous: null})), 'utf8'));
   const dupId = this.byContent.get(content_key);
   if (dupId) {
    const dup = this.registry.get(dupId);
    return {package_id: dupId, version: dup.version, digest: dup.digest, idempotent: true};
   }
   const versions = this.byMeasure.get(input.measure_id) ?? [];
   const version = versions.length + 1;
   const previous = versions.length ? versions[versions.length - 1] : null;
   const core = manifestCore({...input, version, previous});
   const digest = sha256Hex(Buffer.from(canonicalize(core), 'utf8'));
   const package_id = packageIdOf(digest);
   const manifest = {...core, digest};
   const tmp = join(this.dirs.stagingSeal, 'sealing-' + randomBytes(8).toString('hex'));
   await mkdir(tmp, {recursive: true});
   const fh = await open(join(tmp, 'manifest.json'), 'w');
   await fh.writeFile(canonicalize(manifest));
   await fh.sync();
   await fh.close();
   await rename(tmp, join(this.dirs.packages, package_id));
   if (this.hooks.afterRename) this.hooks.afterRename(); // 演练钩子：模拟封存中途进程崩溃
   const entry = {package_id, measure_id: input.measure_id, version, digest, content_key, sealed_at: new Date(this.now()).toISOString()};
   await appendFile(this.registryPath, JSON.stringify(entry) + '\n');
   this.registry.set(package_id, entry);
   this.byMeasure.set(input.measure_id, [...versions, package_id]);
   this.byContent.set(content_key, package_id);
   return {package_id, version, digest, idempotent: false};
  });
 }

 async getPackage(packageId) {
  await this.init();
  if (!idRe('pkg').test(String(packageId)) || !this.registry.has(packageId)) throw new HttpError(404, 'PACKAGE_NOT_FOUND', '证据包不存在或封存未完成');
  try {
   return JSON.parse(await readFile(join(this.dirs.packages, packageId, 'manifest.json'), 'utf8'));
  } catch {
   throw new HttpError(409, 'MANIFEST_UNREADABLE', '证据包清单不可读，封存内容可能已损坏');
  }
 }

 async listPackages(measureId) {
  await this.init();
  return [...this.registry.values()]
   .filter(e => !measureId || e.measure_id === measureId)
   .sort((a, b) => a.sealed_at < b.sealed_at ? -1 : a.sealed_at > b.sealed_at ? 1 : 0);
 }

 async versionsOf(measureId) {
  await this.init();
  return (this.byMeasure.get(measureId) ?? []).map(id => ({package_id: id, version: this.registry.get(id).version}));
 }

 async verifyPackage(packageId) {
  const manifest = await this.getPackage(packageId);
  const {digest, ...core} = manifest;
  const recomputed = sha256Hex(Buffer.from(canonicalize(core), 'utf8'));
  const digest_ok = recomputed === digest && packageIdOf(digest) === packageId;
  const files = [];
  for (const f of manifest.files) {
   try {
    const buf = await readFile(join(this.dirs.blobs, f.sha256));
    const actual = sha256Hex(buf);
    const ok = actual === f.sha256 && buf.length === f.size;
    files.push({name: f.name, sha256: f.sha256, ok, ...(ok ? {} : {actual})});
   } catch {
    files.push({name: f.name, sha256: f.sha256, ok: false, error: '内容缺失'});
   }
  }
  return {package_id: packageId, ok: digest_ok && files.every(f => f.ok), digest_ok, files};
 }

 // 下载前重算摘要：损坏内容绝不流出。
 async readPackageFileVerified(packageId, name) {
  const manifest = await this.getPackage(packageId);
  const entry = manifest.files.find(f => f.name === name);
  if (!entry) throw new HttpError(404, 'FILE_NOT_IN_PACKAGE', '文件不在证据包中', {file: name});
  let buf;
  try { buf = await readFile(join(this.dirs.blobs, entry.sha256)); }
  catch { throw new HttpError(409, 'INTEGRITY_FAILED', '证据内容缺失，完整性校验失败，已拒绝提供下载', {file: name}); }
  const actual = sha256Hex(buf);
  if (actual !== entry.sha256 || buf.length !== entry.size) {
   throw new HttpError(409, 'INTEGRITY_FAILED', '证据包完整性校验失败，已拒绝把损坏内容交给复核员', {file: name, expected: entry.sha256, actual});
  }
  return {buf, entry};
 }

 // ---- 复核意见与撤回记录（只追加，不改写） ----

 async addReview(input) {
  return this.#enqueue(async () => {
   const manifest = await this.getPackage(input.package_id);
   if (manifest.version !== input.version) {
    throw new HttpError(409, 'VERSION_MISMATCH', '复核意见必须绑定实际存在的证据包版本', {package_version: manifest.version, requested: input.version});
   }
   const review = {review_id: 'rev_' + randomBytes(8).toString('hex'), ...input, created_at: new Date(this.now()).toISOString()};
   await appendFile(this.reviewsPath, JSON.stringify(review) + '\n');
   this.reviews.push(review);
   return review;
  });
 }

 async listReviews(packageId, version) {
  await this.getPackage(packageId);
  return this.reviews.filter(r => r.package_id === packageId && (version === undefined || r.version === version));
 }

 async addWithdrawal(packageId, input) {
  return this.#enqueue(async () => {
   await this.getPackage(packageId);
   const withdrawal = {withdrawal_id: 'wd_' + randomBytes(8).toString('hex'), package_id: packageId, ...input, created_at: new Date(this.now()).toISOString()};
   await appendFile(this.withdrawalsPath, JSON.stringify(withdrawal) + '\n');
   this.withdrawals.push(withdrawal);
   return withdrawal;
  });
 }

 async listWithdrawals(packageId) {
  await this.getPackage(packageId);
  return this.withdrawals.filter(w => w.package_id === packageId);
 }

 // ---- 授权下载 ----

 async issueGrant(packageId, file, ttlSeconds) {
  return this.#enqueue(async () => {
   const manifest = await this.getPackage(packageId);
   if (!manifest.files.some(f => f.name === file)) throw new HttpError(404, 'FILE_NOT_IN_PACKAGE', '文件不在证据包中', {file});
   const token_id = randomBytes(16).toString('hex');
   const now = this.now();
   const rec = {token_id, package_id: packageId, file, issued_at: now, expires_at: now + ttlSeconds * 1000, uses: 0};
   this.grants.set(token_id, rec);
   await this.#saveGrants();
   const sig = createHmac('sha256', this.secret).update(token_id).digest('hex');
   return {token: `${token_id}.${sig}`, package_id: packageId, file, expires_at: new Date(rec.expires_at).toISOString()};
  });
 }

 async resolveGrant(token) {
  return this.#enqueue(async () => {
   await this.init();
   const [id, sig] = String(token ?? '').split('.');
   const expect = id ? createHmac('sha256', this.secret).update(id).digest('hex') : '';
   if (!id || !sig || sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
    throw new HttpError(403, 'GRANT_INVALID', '下载授权无效');
   }
   const rec = this.grants.get(id);
   if (!rec) throw new HttpError(403, 'GRANT_INVALID', '下载授权无效或已撤销');
   if (this.now() >= rec.expires_at) {
    throw new HttpError(410, 'GRANT_EXPIRED', '下载授权已过期，过期重放不能获取原件', {expired_at: new Date(rec.expires_at).toISOString()});
   }
   rec.uses += 1;
   await this.#saveGrants();
   return {package_id: rec.package_id, file: rec.file};
  });
 }

 async #saveGrants() {
  const tmp = this.grantsPath + '.tmp';
  await writeFile(tmp, JSON.stringify(Object.fromEntries(this.grants), null, 2));
  await rename(tmp, this.grantsPath);
 }
}
