// 封存存储引擎：仅追加事件日志 + 暂存/封存双区文件布局。
//
// 目录布局：
//   events.log                       仅追加审计事件
//   secret                           封存清单 HMAC 密钥（600）
//   staging/<pkg>/                   送审暂存（可续传、可整理，永不可下载）
//     manifest.json                  送审申报与期望摘要
//     chunks/f<idx>/<n>.part         分块（.tmp 写入后原子改名）
//     assembled/f<idx>.blob          全分块到齐后顺序组装
//   sealed/<pkg>.tmp-*               封存中转目录（崩溃后由对账清除）
//   sealed/<pkg>/                    已封存证据包（唯一可下载区，原子改名进入）
//     files/f<idx>.blob
//     manifest.json + manifest.sig
//     records.jsonl                  撤回/复核记录镜像（仅追加）
import {promises as fs, constants as fsConst, createReadStream} from 'node:fs';
import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {join, dirname, basename} from 'node:path';
import {mkdirp} from './fsutil.mjs';
import {canonicalJSON, packageDigest, validateSubmission, validateReview} from './contracts.mjs';

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const shaFile = async path => new Promise((resolve, reject) => {
 const h = createHash('sha256');
 const s = createReadStream(path);
 s.on('error', reject);
 s.on('data', d => h.update(d));
 s.on('end', () => resolve(h.digest('hex')));
});

export class StoreError extends Error {
 constructor(status, code, detail) {
  super(code);
  this.status = status;
  this.code = code;
  this.detail = detail;
 }
}

// 每个证据包一把串行锁，避免乱序并发写互相踩踏。
function mutex() {
 let tail = Promise.resolve();
 return fn => {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
 };
}

export class Store {
 constructor(root) {
  this.root = root;
  this.staging = join(root, 'staging');
  this.sealed = join(root, 'sealed');
  this.eventPath = join(root, 'events.log');
  this.secretPath = join(root, 'secret');
  this.pkgs = new Map();
  this.tickets = new Map();
  this.locks = new Map();
  this.appendChain = Promise.resolve();
 }

 lock(pkg) {
  if (!this.locks.has(pkg)) this.locks.set(pkg, mutex());
  return this.locks.get(pkg);
 }

 async append(event) {
  const line = JSON.stringify({at: new Date().toISOString(), ...event}) + '\n';
  this.appendChain = this.appendChain.then(async () => {
   await fs.appendFile(this.eventPath, line, 'utf8');
  });
  await this.appendChain;
 }

 sign(canonical) {
  return createHmac('sha256', this.secret).update(canonical, 'utf8').digest('hex');
 }

 async loadSecret() {
  try {
   this.secret = await fs.readFile(this.secretPath);
  } catch {
   await mkdirp(this.root);
   this.secret = randomBytes(32);
   await fs.writeFile(this.secretPath, this.secret, {mode: 0o600});
  }
 }

 static async open(root) {
  const store = new Store(root);
  await mkdirp(store.staging);
  await mkdirp(store.sealed);
  await store.loadSecret();
  await store.replay();
  await store.reconcile();
  return store;
 }

 // 重放事件日志，重建内存索引。
 async replay() {
  let text;
  try { text = await fs.readFile(this.eventPath, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
   if (!line.trim()) continue;
   const e = JSON.parse(line);
   this.apply(e);
  }
 }

 apply(e) {
  switch (e.type) {
   case 'package_created': {
    if (!this.pkgs.has(e.pkg)) {
     this.pkgs.set(e.pkg, {
      pkg: e.pkg, status: 'open', submission: e.submission, digest: e.digest,
      supersedes: e.submission.supersedes ?? null,
      received: Object.fromEntries(e.submission.files.map((f, i) => [i, new Set()])),
      assembled: new Set(), created_at: e.at
     });
    }
    break;
   }
   case 'chunk_received': {
    const p = this.pkgs.get(e.pkg);
    if (p) p.received[e.file_index]?.add(e.index);
    break;
   }
   case 'chunk_reset': {
    const p = this.pkgs.get(e.pkg);
    if (p) {
     p.received[e.file_index]?.delete(e.index);
     p.assembled.delete(e.file_index);
    }
    break;
   }
   case 'file_assembled': {
    const p = this.pkgs.get(e.pkg);
    if (p) p.assembled.add(e.file_index);
    break;
   }
   case 'package_sealed': {
    const p = this.pkgs.get(e.pkg);
    if (p && p.status !== 'sealed') {
     p.status = 'sealed';
     p.sealed_at = e.at;
    }
    break;
   }
   case 'seal_rejected': break;
   case 'withdrawal_added': {
    const p = this.pkgs.get(e.pkg);
    if (p) p.withdrawals = [...(p.withdrawals ?? []), {
      record_id: e.record_id, author: e.author, statement: e.statement, created_at: e.at
     }];
    break;
   }
   case 'review_added': {
    const p = this.pkgs.get(e.pkg);
    if (p) p.reviews = [...(p.reviews ?? []), {
      review_id: e.review_id, reviewer: e.reviewer, decision: e.decision,
      opinion: e.opinion, check_site: e.check_site,
      package_version: `${e.pkg}@${e.digest}`, created_at: e.at
     }];
    break;
   }
   case 'ticket_issued':
    this.tickets.set(e.token, {pkg: e.pkg, jti: e.jti, expires_at: e.expires_at, redeemed: false});
    break;
   case 'ticket_redeemed': {
    const t = this.tickets.get(e.token);
    if (t) t.redeemed = true;
    break;
   }
  }
 }

  // 崩溃对账：以封存目录为权威，清除半包中转，补齐事件，挂接补交链。
  async reconcile() {
  let entries = [];
  try { entries = await fs.readdir(this.sealed); } catch {}
  for (const name of entries) {
   if (name.includes('.tmp-')) {
    await fs.rm(join(this.sealed, name), {recursive: true, force: true});
    continue;
   }
   const manifestPath = join(this.sealed, name, 'manifest.json');
   try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (!this.pkgs.has(manifest.pkg)) {
     // 封存改名已落地而事件未及写入：以封存目录补建索引并补记事件。
     this.apply({type: 'package_created', pkg: manifest.pkg, submission: manifest.submission, digest: manifest.digest, at: manifest.sealed_at});
     for (const f of manifest.files) this.apply({type: 'file_assembled', pkg: manifest.pkg, file_index: f.index});
     this.apply({type: 'package_sealed', pkg: manifest.pkg, at: manifest.sealed_at});
     await this.append({type: 'package_sealed', pkg: manifest.pkg, digest: manifest.digest, recovered: true});
    } else {
     const p = this.pkgs.get(manifest.pkg);
     p.status = 'sealed';
     p.sealed_at = manifest.sealed_at;
    }
    // 撤回/复核记录以封存包内 records.jsonl 为权威重建（事件日志缺失也不丢结论）。
    const p = this.pkgs.get(manifest.pkg);
    p.reviews = [];
    p.withdrawals = [];
    try {
     const text = await fs.readFile(join(this.sealed, name, 'records.jsonl'), 'utf8');
     for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.type === 'review') {
       p.reviews.push({
        review_id: r.review_id, reviewer: r.reviewer, decision: r.decision,
        opinion: r.opinion, check_site: r.check_site,
        package_version: r.package_version, created_at: r.created_at
       });
      } else if (r.type === 'withdrawal') {
       p.withdrawals.push({record_id: r.record_id, author: r.author, statement: r.statement, created_at: r.created_at});
      }
     }
    } catch {}
   } catch {
    await fs.rm(join(this.sealed, name), {recursive: true, force: true});
   }
  }
  // 已封存包的暂存目录是冗余，清理；未封存留待续传。
  for (const p of this.pkgs.values()) {
   if (p.status === 'sealed') {
    await fs.rm(join(this.staging, p.pkg), {recursive: true, force: true});
    if (p.supersedes) {
     const old = this.pkgs.get(p.supersedes);
     if (old) old.superseded_by = p.pkg;
    }
    continue;
   }
   // 暂存包：以磁盘上实际存在的分块为准重建接收状态（重置后崩溃/事件滞后都不误判）。
   for (let fi = 0; fi < p.submission.files.length; fi++) {
    const onDisk = new Set();
    try {
     for (const part of await fs.readdir(join(this.staging, p.pkg, 'chunks', `f${fi}`))) {
      const m = part.match(/^(\d+)\.part$/);
      if (m) onDisk.add(Number(m[1]));
     }
    } catch {}
    p.received[fi] = onDisk;
    if (!(await this.assembledBlobValid(p, fi))) p.assembled.delete(fi);
    else p.assembled.add(fi);
   }
   if (p.supersedes) {
    const old = this.pkgs.get(p.supersedes);
    if (old) old.superseded_by = p.pkg;
   }
  }
 }

 async assembledBlobValid(p, fi) {
  const file = p.submission.files[fi];
  const path = join(this.staging, p.pkg, 'assembled', `f${fi}.blob`);
  try {
   if ((await fs.stat(path)).size !== file.size) return false;
   return await shaFile(path) === file.sha256;
  } catch { return false; }
 }

 // ---------- 送审建包 ----------
 async createPackage(input) {
  const err = validateSubmission(input);
  if (err) throw new StoreError(400, 'invalid_submission', err);
  const submission = structuredClone(input);
  const digest = packageDigest(submission);
  const pkg = `pkg_${digest.slice(0, 20)}`;
  return this.lock(pkg)(async () => {
   const existing = this.pkgs.get(pkg);
   if (existing) {
    if (existing.status === 'sealed') throw new StoreError(409, 'already_sealed', '该内容已封存，不能改传；补交请另建新包');
    return {pkg, digest, reused: true, ...this.statusView(existing)};
   }
   for (const [i, f] of submission.files.entries()) {
    const count = Math.ceil(f.size / f.chunk_size);
    if (!Array.isArray(f.chunks) || f.chunks.length !== count) {
     throw new StoreError(400, 'invalid_submission', `文件${i + 1}分块摘要数量应为 ${count}`);
    }
    if (f.chunks.some(c => !/^[0-9a-f]{64}$/.test(c))) throw new StoreError(400, 'invalid_submission', `文件${i + 1}存在非法分块摘要`);
   }
   const dir = join(this.staging, pkg);
   await mkdirp(join(dir, 'chunks'));
   await mkdirp(join(dir, 'assembled'));
   await fs.writeFile(join(dir, 'manifest.json'), canonicalJSON({submission, digest}) + '\n', 'utf8');
   await this.append({type: 'package_created', pkg, submission, digest});
   this.apply({type: 'package_created', pkg, submission, digest, at: new Date().toISOString()});
   if (submission.supersedes) {
    const old = this.pkgs.get(submission.supersedes);
    if (old) old.superseded_by = pkg;
   }
   return {pkg, digest, reused: false, ...this.statusView(this.pkgs.get(pkg))};
  });
 }

 statusView(p) {
  return {
   status: p.status,
   supersedes: p.supersedes,
   superseded_by: p.superseded_by ?? null,
   files: p.submission.files.map((f, i) => {
    const received = [...(p.received[i] ?? [])].sort((a, b) => a - b);
    const total = f.chunks.length;
    return {
     file_index: i, name: f.name, size: f.size, chunk_size: f.chunk_size,
     chunk_count: total, received_chunks: received,
     missing_chunks: Array.from({length: total}, (_, n) => n).filter(n => !received.includes(n)),
     assembled: p.assembled.has(i)
    };
   })
  };
 }

 async getStatus(pkg) {
  const p = this.requireOpenOrSealed(pkg);
  const view = {pkg, digest: p.digest, created_at: p.created_at, ...this.statusView(p)};
  if (p.status === 'sealed') {
   view.sealed_at = p.sealed_at;
   view.reviews = p.reviews ?? [];
   view.withdrawals = p.withdrawals ?? [];
  }
  return view;
 }

 requireOpenOrSealed(pkg) {
  const p = this.pkgs.get(pkg);
  if (!p) throw new StoreError(404, 'package_not_found', '证据包不存在');
  return p;
 }

 // ---------- 分块上传：乱序、重复、损坏、冲突分别给出明确结果 ----------
 async putChunk(pkg, fileIndex, chunkIndex, bytes) {
  const p = this.requireOpenOrSealed(pkg);
  return this.lock(pkg)(async () => {
   if (p.status === 'sealed') throw new StoreError(409, 'already_sealed', '已封存包不接受分块');
   const file = p.submission.files[fileIndex];
   if (!file) throw new StoreError(404, 'file_not_found', '文件序号不存在');
   const total = file.chunks.length;
   if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= total) {
    throw new StoreError(404, 'chunk_not_found', `分块序号应在 0..${total - 1}`);
   }
   const expectedSize = chunkIndex === total - 1 ? file.size - (total - 1) * file.chunk_size : file.chunk_size;
   if (bytes.length !== expectedSize) {
    throw new StoreError(422, 'chunk_length_mismatch', {expected: expectedSize, actual: bytes.length});
   }
   const actualHash = sha256(bytes);
   if (actualHash !== file.chunks[chunkIndex]) {
    // 损坏分块：明确拒绝、不落盘（已存在正确分块时判为冲突，防止覆盖）。
    const already = p.received[fileIndex]?.has(chunkIndex);
    throw new StoreError(already ? 409 : 422, already ? 'chunk_conflict' : 'chunk_corrupt',
     {chunk_index: chunkIndex, expected: file.chunks[chunkIndex], actual: actualHash});
   }
   const part = join(this.staging, pkg, 'chunks', `f${fileIndex}`, `${chunkIndex}.part`);
   if (p.received[fileIndex].has(chunkIndex)) {
    const onDisk = await shaFile(part);
    if (onDisk === actualHash) return {result: 'duplicate_ignored', file_index: fileIndex, chunk_index: chunkIndex};
    throw new StoreError(409, 'chunk_conflict', {chunk_index: chunkIndex});
   }
   await mkdirp(dirname(part));
   const tmp = `${part}.tmp-${process.pid}`;
   await fs.writeFile(tmp, bytes);
   await fs.rename(tmp, part);
   p.received[fileIndex].add(chunkIndex);
   await this.append({type: 'chunk_received', pkg, file_index: fileIndex, index: chunkIndex, sha256: actualHash});
   return {result: 'stored', file_index: fileIndex, chunk_index: chunkIndex};
  });
 }

 // 重置某个损坏/冲突分块：仅开放包可操作，重置后可重新上传。
 async resetChunk(pkg, fileIndex, chunkIndex) {
  const p = this.requireOpenOrSealed(pkg);
  return this.lock(pkg)(async () => {
   if (p.status === 'sealed') throw new StoreError(409, 'already_sealed');
   const part = join(this.staging, pkg, 'chunks', `f${fileIndex}`, `${chunkIndex}.part`);
   await fs.rm(part, {force: true});
   p.received[fileIndex]?.delete(chunkIndex);
   p.assembled.delete(fileIndex);
   await fs.rm(join(this.staging, pkg, 'assembled', `f${fileIndex}.blob`), {force: true});
   await this.append({type: 'chunk_reset', pkg, file_index: fileIndex, index: chunkIndex});
   return {result: 'chunk_reset', file_index: fileIndex, chunk_index: chunkIndex};
  });
 }

 // ---------- 顺序组装与单文件摘要校验 ----------
 async assembleFile(pkg, fileIndex) {
  const p = this.requireOpenOrSealed(pkg);
  return this.lock(pkg)(async () => {
   if (p.status === 'sealed') throw new StoreError(409, 'already_sealed');
   const file = p.submission.files[fileIndex];
   if (!file) throw new StoreError(404, 'file_not_found');
   const missing = file.chunks.map((_, n) => n).filter(n => !p.received[fileIndex].has(n));
   if (missing.length) throw new StoreError(409, 'chunks_missing', {file_index: fileIndex, missing});
   if (p.assembled.has(fileIndex)) return {result: 'already_assembled', file_index: fileIndex};
   const dir = join(this.staging, pkg);
   const out = join(dir, 'assembled', `f${fileIndex}.blob`);
   const tmp = `${out}.tmp-${process.pid}`;
   try {
    // 必须按序号顺序拼接，乱序上传不影响最终组装顺序。
    await fs.writeFile(tmp, Buffer.alloc(0));
    for (let n = 0; n < file.chunks.length; n++) {
     const part = join(dir, 'chunks', `f${fileIndex}`, `${n}.part`);
     await fs.appendFile(tmp, await fs.readFile(part));
    }
   } catch (err) {
    await fs.rm(tmp, {force: true});
    throw err;
   }
   const actual = await shaFile(tmp);
   if (actual !== file.sha256) {
    await fs.rm(tmp, {force: true});
    throw new StoreError(422, 'file_digest_mismatch', {file_index: fileIndex, name: file.name, expected: file.sha256, actual});
   }
   await fs.rename(tmp, out);
   p.assembled.add(fileIndex);
   await this.append({type: 'file_assembled', pkg, file_index: fileIndex, sha256: actual});
   return {result: 'assembled', file_index: fileIndex, sha256: actual};
  });
 }

 // ---------- 原子封存 ----------
 async seal(pkg) {
  const p = this.requireOpenOrSealed(pkg);
  return this.lock(pkg)(async () => {
   if (p.status === 'sealed') return {result: 'already_sealed', pkg, digest: p.digest, sealed_at: p.sealed_at};
   const incomplete = [];
   for (const [i] of p.submission.files.entries()) {
    if (!p.assembled.has(i)) incomplete.push(i);
   }
   if (incomplete.length) {
    await this.append({type: 'seal_rejected', pkg, reason: 'incomplete_files', detail: {incomplete}});
    throw new StoreError(422, 'incomplete_files', {incomplete});
   }
   // 整包摘要复核：防止暂存清单被篡改。
   const digest = packageDigest(p.submission);
   if (digest !== p.digest) {
    await this.append({type: 'seal_rejected', pkg, reason: 'package_digest_mismatch'});
    throw new StoreError(422, 'package_digest_mismatch', {expected: p.digest, actual: digest});
   }
   const manifest = {
    pkg, version: 1, digest, sealed_at: new Date().toISOString(),
    submission: p.submission,
    measure_id: p.submission.measure_id, measure: p.submission.measure,
    site: p.submission.site, capture_at: p.submission.capture_at,
    supersedes: p.supersedes,
    files: p.submission.files.map((f, i) => ({
     index: i, id: `f${String(i).padStart(3, '0')}`,
     name: f.name, path: f.path, size: f.size, sha256: f.sha256,
     chunk_size: f.chunk_size, chunks: f.chunks,
     media: f.media ?? null, role: f.role ?? null
    }))
   };
   const tmpDir = join(this.sealed, `${pkg}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
   try {
    await mkdirp(join(tmpDir, 'files'));
    for (const f of manifest.files) {
     await fs.copyFile(
      join(this.staging, pkg, 'assembled', `f${f.index}.blob`),
      join(tmpDir, 'files', `${f.id}.blob`)
     );
    }
    const body = canonicalJSON(manifest);
    await fs.writeFile(join(tmpDir, 'manifest.json'), body + '\n', 'utf8');
    await fs.writeFile(join(tmpDir, 'manifest.sig'), this.sign(body), 'utf8');
    // 整目录一次改名：封存成功对外原子可见；此前任何崩溃都只留下 tmp 半包，由对账清除。
    await fs.rename(tmpDir, join(this.sealed, pkg));
   } catch (err) {
    await fs.rm(tmpDir, {recursive: true, force: true});
    throw err;
   }
   p.status = 'sealed';
   p.sealed_at = manifest.sealed_at;
   await this.append({type: 'package_sealed', pkg, digest, sealed_at: manifest.sealed_at});
   await fs.rm(join(this.staging, pkg), {recursive: true, force: true});
   return {result: 'sealed', pkg, digest, sealed_at: manifest.sealed_at};
  });
 }

 sealedDir(pkg) { return join(this.sealed, pkg); }

 async readSealedManifest(pkg) {
  const p = this.requireOpenOrSealed(pkg);
  if (p.status !== 'sealed') throw new StoreError(409, 'not_sealed', '证据包尚未封存');
  const dir = this.sealedDir(pkg);
  const body = await fs.readFile(join(dir, 'manifest.json'), 'utf8');
  const sig = await fs.readFile(join(dir, 'manifest.sig'), 'utf8');
  const expected = this.sign(body.trimEnd());
  const given = sig.trim();
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
   throw new StoreError(410, 'manifest_tampered', '封存清单签名不符');
  }
  return {manifest: JSON.parse(body), p};
 }

 // 包完整性校验：清单签名 + 每个原件重新哈希 + 字节数。
 async verify(pkg) {
  const {manifest} = await this.readSealedManifest(pkg);
  const files = [];
  let ok = true;
  for (const f of manifest.files) {
   const path = join(this.sealedDir(pkg), 'files', `${f.id}.blob`);
   let actual = null;
   let size = null;
   try { actual = await shaFile(path); size = (await fs.stat(path)).size; } catch {}
   const fileOk = actual === f.sha256 && size === f.size;
   ok = ok && fileOk;
   files.push({id: f.id, name: f.name, size, expected_size: f.size, expected: f.sha256, actual, ok: fileOk});
  }
  return {pkg, digest: manifest.digest, ok, files};
 }

 // ---------- 撤回：只新增记录，封存包字节与清单永不改写 ----------
 async withdraw(pkg, body) {
  if (!body || typeof body !== 'object' || typeof body.author !== 'string' || !body.author.trim()) throw new StoreError(400, 'invalid_withdrawal', '撤回人缺失');
  if (typeof body.statement !== 'string' || !body.statement.trim()) throw new StoreError(400, 'invalid_withdrawal', '撤回说明缺失');
  const p = this.requireOpenOrSealed(pkg);
  return this.lock(pkg)(async () => {
   if (p.status !== 'sealed') throw new StoreError(409, 'not_sealed', '仅已封存包可登记撤回；未封存材料可直接重新整理送审');
   const record_id = `WD-${String((p.withdrawals?.length ?? 0) + 1).padStart(4, '0')}`;
   const at = new Date().toISOString();
   const record = {type: 'withdrawal', record_id, pkg, package_digest: p.digest, author: body.author, statement: body.statement, created_at: at};
   await fs.appendFile(join(this.sealedDir(pkg), 'records.jsonl'), JSON.stringify(record) + '\n', 'utf8');
   await this.append({type: 'withdrawal_added', pkg, record_id, author: body.author, statement: body.statement});
   this.apply({type: 'withdrawal_added', pkg, record_id, author: body.author, statement: body.statement, at});
   return record;
  });
 }

 // ---------- 复核意见：绑定检查位置与证据包版本 ----------
 async review(pkg, body) {
  const err = validateReview(body);
  if (err) throw new StoreError(400, 'invalid_review', err);
  const p = this.requireOpenOrSealed(pkg);
  return this.lock(pkg)(async () => {
   if (p.status !== 'sealed') throw new StoreError(409, 'not_sealed', '仅已封存包可复核');
   const review_id = `RV-${String((p.reviews?.length ?? 0) + 1).padStart(4, '0')}`;
   const at = new Date().toISOString();
   const record = {
    type: 'review', review_id, pkg, package_version: `${pkg}@${p.digest}`,
    reviewer: body.reviewer, decision: body.decision, opinion: body.opinion,
    check_site: body.check_site, created_at: at
   };
   await fs.appendFile(join(this.sealedDir(pkg), 'records.jsonl'), JSON.stringify(record) + '\n', 'utf8');
   await this.append({type: 'review_added', pkg, review_id, digest: p.digest, reviewer: body.reviewer, decision: body.decision, opinion: body.opinion, check_site: body.check_site});
   this.apply({type: 'review_added', pkg, review_id, digest: p.digest, reviewer: body.reviewer, decision: body.decision, opinion: body.opinion, check_site: body.check_site, at});
   return record;
  });
 }

 // ---------- 授权下载：签名票据、一次性、绝对过期、下载前完整性校验 ----------
 issueToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', this.secret).update(body).digest('base64url');
  return `${body}.${sig}`;
 }

 parseToken(token) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) throw new StoreError(401, 'bad_token', '票据格式错误');
  const expected = createHmac('sha256', this.secret).update(body).digest('base64url');
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { throw new StoreError(401, 'bad_token'); }
  const want = Buffer.from(expected, 'base64url');
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw new StoreError(401, 'bad_token', '票据签名不符');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
 }

 async issueTicket(pkg, ttlSeconds = 300) {
  const {p} = await this.readSealedManifest(pkg);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 86400) throw new StoreError(400, 'invalid_ttl');
  const now = Date.now();
  const jti = randomBytes(12).toString('hex');
  const expires_at = new Date(now + ttlSeconds * 1000).toISOString();
  const token = this.issueToken({pkg, jti, iat: now, exp: now + ttlSeconds * 1000});
  await this.append({type: 'ticket_issued', token, pkg, jti, issued_at: new Date(now).toISOString(), expires_at});
  this.apply({type: 'ticket_issued', token, pkg, jti, expires_at});
  return {token, pkg, expires_at, ttl_seconds: ttlSeconds};
 }

 // 核销前做完整校验；过期、重放、损坏一律拒绝出原件。
 async redeem(token) {
  let payload;
  try { payload = this.parseToken(token); } catch (e) { throw e; }
  const rec = this.tickets.get(token);
  if (!rec || rec.jti !== payload.jti || rec.pkg !== payload.pkg) throw new StoreError(401, 'ticket_unknown', '票据未登记或已吊销');
  if (Date.now() >= payload.exp) throw new StoreError(410, 'ticket_expired', {expires_at: new Date(payload.exp).toISOString()});
  if (rec.redeemed) throw new StoreError(409, 'ticket_replayed', '一次性票据已使用，重放不能获取原件');
  const report = await this.verify(payload.pkg);
  if (!report.ok) throw new StoreError(410, 'package_corrupt', '完整性校验失败，拒绝把坏包交给复核员');
  await this.append({type: 'ticket_redeemed', token, redeemed_at: new Date().toISOString()});
  rec.redeemed = true;
  return report;
 }
}
