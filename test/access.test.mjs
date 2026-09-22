import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startServer, api, uploadFile} from './helpers.mjs';
import {fileBytes, SAMPLE_FILE_DEFS} from '../sample.mjs';

async function sealedWithFile(base, idx = 0) {
 const def = SAMPLE_FILE_DEFS[idx];
 const buf = fileBytes(def.name, def.size);
 const {file} = await uploadFile(base, def.name, buf);
 const res = await api(base, 'POST', '/packages', {measure_id: 'ZL-2026-100', site: '虚构地点', capture_at: '2026-09-10T08:00:00+08:00', submitted_by: '送审员甲', files: [file]});
 if (res.status !== 201) throw new Error('封存失败: ' + JSON.stringify(res.json));
 return {buf, file, package_id: res.json.package_id};
}

test('授权下载返回原件并携带摘要', async () => {
 const t = await startServer();
 try {
  const {buf, file, package_id} = await sealedWithFile(t.base);
  const g = await api(t.base, 'POST', `/packages/${package_id}/grants`, {file: file.name, ttl_seconds: 60});
  assert.equal(g.status, 201);
  const res = await fetch(t.base + g.json.download_url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-sha256'), file.sha256);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), buf);
 } finally { await t.close(); }
});

test('过期授权重放不能获取原件', async () => {
 let now = 1800000000000;
 const t = await startServer({now: () => now});
 try {
  const {file, package_id} = await sealedWithFile(t.base);
  const g = await api(t.base, 'POST', `/packages/${package_id}/grants`, {file: file.name, ttl_seconds: 30});
  const ok = await fetch(t.base + g.json.download_url);
  assert.equal(ok.status, 200);
  await ok.arrayBuffer();
  now += 31000; // 授权过期
  const replay = await fetch(t.base + g.json.download_url);
  assert.equal(replay.status, 410);
  assert.ok(replay.headers.get('content-type').includes('application/json'));
  const body = await replay.json();
  assert.equal(body.error.code, 'GRANT_EXPIRED');
 } finally { await t.close(); }
});

test('伪造或篡改的授权被拒绝', async () => {
 const t = await startServer();
 try {
  const {file, package_id} = await sealedWithFile(t.base);
  const g = await api(t.base, 'POST', `/packages/${package_id}/grants`, {file: file.name, ttl_seconds: 60});
  const [id] = g.json.token.split('.');
  assert.equal((await fetch(`${t.base}/download/${id}.${'0'.repeat(64)}`)).status, 403);
  assert.equal((await fetch(`${t.base}/download/${'1'.repeat(32)}.${'0'.repeat(64)}`)).status, 403);
  assert.equal((await fetch(`${t.base}/download/not-a-token`)).status, 403);
 } finally { await t.close(); }
});

test('授权绑定具体文件，不能换名取件', async () => {
 const t = await startServer();
 try {
  const a = await sealedWithFile(t.base, 0);
  const g = await api(t.base, 'POST', `/packages/${a.package_id}/grants`, {file: a.file.name, ttl_seconds: 60});
  const res = await fetch(t.base + g.json.download_url);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), a.buf); // 只能取到授权指定的文件
  const other = await api(t.base, 'POST', `/packages/${a.package_id}/grants`, {file: '不存在的文件.jpg', ttl_seconds: 60});
  assert.equal(other.status, 404);
 } finally { await t.close(); }
});

test('损坏的分块内容不会被交给复核员', async () => {
 const t = await startServer();
 try {
  const {file, package_id} = await sealedWithFile(t.base);
  assert.equal((await api(t.base, 'GET', `/packages/${package_id}/verify`)).json.ok, true);
  // 模拟存储层分块损坏：篡改已封存内容的一个字节
  const blobPath = join(t.storeDir, 'blobs', file.sha256);
  const corrupted = Buffer.from(await readFile(blobPath));
  corrupted[100] ^= 0xff;
  await writeFile(blobPath, corrupted);
  // 完整性校验报告坏包
  const verify = (await api(t.base, 'GET', `/packages/${package_id}/verify`)).json;
  assert.equal(verify.ok, false);
  assert.equal(verify.files[0].ok, false);
  assert.notEqual(verify.files[0].actual, file.sha256);
  // 即使授权有效，也拒绝把坏包交给复核员
  const g = await api(t.base, 'POST', `/packages/${package_id}/grants`, {file: file.name, ttl_seconds: 60});
  assert.equal(g.status, 201);
  const res = await fetch(t.base + g.json.download_url);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, 'INTEGRITY_FAILED');
  assert.equal(body.error.details.expected, file.sha256);
 } finally { await t.close(); }
});

test('重启后已封存包、复核结论与有效授权仍可用', async () => {
 const t = await startServer();
 try {
  const {buf, file, package_id} = await sealedWithFile(t.base);
  await api(t.base, 'POST', '/reviews', {package_id, version: 1, location: '桥头 K1+000', conclusion: '同意通过', reviewer: '复核员丙'});
  const g = await api(t.base, 'POST', `/packages/${package_id}/grants`, {file: file.name, ttl_seconds: 3600});
  await t.restart();
  const res = await fetch(t.base + `/download/${g.json.token}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), buf);
  const reviews = (await api(t.base, 'GET', `/packages/${package_id}/versions/1/reviews`)).json.reviews;
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].conclusion, '同意通过');
  assert.equal((await api(t.base, 'GET', `/packages/${package_id}/verify`)).json.ok, true);
 } finally { await t.close(); }
});
