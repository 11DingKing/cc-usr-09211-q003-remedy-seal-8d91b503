import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startServer, api, uploadFile} from './helpers.mjs';
import {fileBytes, SAMPLE_FILE_DEFS, sampleRecords} from '../sample.mjs';

const bytesOf = (i) => fileBytes(SAMPLE_FILE_DEFS[i].name, SAMPLE_FILE_DEFS[i].size);

async function sealSamplePackage(base, files = [0, 1, 2]) {
 const uploaded = [];
 for (const i of files) uploaded.push((await uploadFile(base, SAMPLE_FILE_DEFS[i].name, bytesOf(i))).file);
 return api(base, 'POST', '/packages', {measure_id: 'ZL-2026-014', submitted_by: '送审员甲', files: uploaded});
}

test('送审封存为不可变证据包并关联样例记录', async () => {
 const t = await startServer({seedRecords: true});
 try {
  const res = await sealSamplePackage(t.base);
  assert.equal(res.status, 201);
  assert.equal(res.json.record_linked, true);
  assert.equal(res.json.version, 1);
  const id = res.json.package_id;
  const detail = (await api(t.base, 'GET', `/packages/${id}`)).json;
  const rec = sampleRecords()[0];
  assert.equal(detail.manifest.site, rec.site);
  assert.equal(detail.manifest.capture_at, rec.capture_at);
  assert.equal(detail.manifest.files.length, 3);
  assert.equal(detail.manifest.digest, res.json.digest);
  assert.equal((await api(t.base, 'GET', `/packages/${id}/verify`)).json.ok, true);
  // 重复送审同一内容：幂等返回同一包，不产生新版本
  const again = await sealSamplePackage(t.base);
  assert.equal(again.status, 200);
  assert.equal(again.json.idempotent, true);
  assert.equal(again.json.package_id, id);
  assert.equal((await api(t.base, 'GET', '/packages')).json.packages.length, 1);
 } finally { await t.close(); }
});

test('已封存包不可改写，撤回说明只能追加撤回记录', async () => {
 const t = await startServer({seedRecords: true});
 try {
  const id = (await sealSamplePackage(t.base)).json.package_id;
  const before = (await api(t.base, 'GET', `/packages/${id}`)).json.manifest;
  for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) {
   const res = await fetch(`${t.base}/packages/${id}`, {method});
   assert.equal(res.status, 405, method);
  }
  const w = await api(t.base, 'POST', `/packages/${id}/withdrawals`, {record_ref: '整改前-路面破损.jpg', reason: '现场说明口径有误，予以撤回', operator: '现场员乙'});
  assert.equal(w.status, 201);
  assert.ok(w.json.withdrawal.withdrawal_id);
  const list = (await api(t.base, 'GET', `/packages/${id}/withdrawals`)).json.withdrawals;
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, '现场说明口径有误，予以撤回');
  assert.equal(list[0].operator, '现场员乙');
  // 已封存包内容未被改写
  const after = (await api(t.base, 'GET', `/packages/${id}`)).json.manifest;
  assert.deepEqual(after, before);
  assert.equal((await api(t.base, 'GET', `/packages/${id}/verify`)).json.ok, true);
 } finally { await t.close(); }
});

test('复核意见绑定检查位置与证据包版本', async () => {
 const t = await startServer({seedRecords: true});
 try {
  const id = (await sealSamplePackage(t.base)).json.package_id;
  // 缺检查位置 → 400
  const noLoc = await api(t.base, 'POST', '/reviews', {package_id: id, version: 1, conclusion: '同意通过', reviewer: '复核员丙'});
  assert.equal(noLoc.status, 400);
  // 版本不存在 → 409
  const wrong = await api(t.base, 'POST', '/reviews', {package_id: id, version: 9, location: '东侧道路 K0+120', conclusion: '同意通过', reviewer: '复核员丙'});
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.error.code, 'VERSION_MISMATCH');
  const ok = await api(t.base, 'POST', '/reviews', {package_id: id, version: 1, location: '东侧道路 K0+120', conclusion: '同意通过', reviewer: '复核员丙'});
  assert.equal(ok.status, 201);
  assert.equal(ok.json.review.location, '东侧道路 K0+120');
  assert.equal(ok.json.review.version, 1);
  assert.equal(ok.json.review.package_id, id);
 } finally { await t.close(); }
});

test('补交材料生成新版本包，原复核结论完整重现', async () => {
 const t = await startServer({seedRecords: true});
 try {
  const v1 = (await sealSamplePackage(t.base)).json;
  await api(t.base, 'POST', '/reviews', {package_id: v1.package_id, version: 1, location: '东侧道路 K0+120', conclusion: '同意通过', reviewer: '复核员丙'});
  const before = (await api(t.base, 'GET', `/packages/${v1.package_id}`)).json.manifest;
  // 补交材料 → 生成版本 2，并链接到上一版
  const v2res = await sealSamplePackage(t.base, [0, 1, 2, 3]);
  assert.equal(v2res.status, 201);
  assert.equal(v2res.json.version, 2);
  const v2 = (await api(t.base, 'GET', `/packages/${v2res.json.package_id}`)).json.manifest;
  assert.equal(v2.previous, v1.package_id);
  assert.equal(v2.files.length, 4);
  // 原包与原复核结论完整重现
  assert.deepEqual((await api(t.base, 'GET', `/packages/${v1.package_id}`)).json.manifest, before);
  const reviews = (await api(t.base, 'GET', `/packages/${v1.package_id}/versions/1/reviews`)).json.reviews;
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].conclusion, '同意通过');
  assert.equal(reviews[0].location, '东侧道路 K0+120');
  assert.equal((await api(t.base, 'GET', `/packages/${v1.package_id}/verify`)).json.ok, true);
  // 措施维度可见两个版本
  const versions = (await api(t.base, 'GET', `/packages/${v1.package_id}`)).json.versions;
  assert.deepEqual(versions.map(v => v.version), [1, 2]);
 } finally { await t.close(); }
});

test('引用未完成上传的文件时拒绝封存', async () => {
 const t = await startServer();
 try {
  const res = await api(t.base, 'POST', '/packages', {
   measure_id: 'ZL-2026-099', site: '虚构地点', capture_at: '2026-09-01T10:00:00+08:00', submitted_by: '送审员甲',
   files: [{name: '缺失.jpg', sha256: 'a'.repeat(64), size: 10}],
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'BLOB_MISSING');
 } finally { await t.close(); }
});
