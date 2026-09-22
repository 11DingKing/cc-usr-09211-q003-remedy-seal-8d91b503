import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {startServer, api, createUpload, putChunk, splitChunks, sha256Hex} from './helpers.mjs';
import {fileBytes} from '../sample.mjs';

test('分块乱序、重复上传与续传状态都有明确结果', async () => {
 const t = await startServer();
 try {
  const buf = fileBytes('乱序.bin', 150000);
  const upload = await createUpload(t.base, '乱序.bin', buf, 65536);
  assert.equal(upload.chunk_count, 3);
  const chunks = splitChunks(buf, 65536);
  // 乱序：先 2 后 0，均被正常接收
  assert.equal((await putChunk(t.base, upload.upload_id, 2, chunks[2])).json.result.status, 'stored');
  assert.equal((await putChunk(t.base, upload.upload_id, 0, chunks[0])).json.result.status, 'stored');
  const mid = (await api(t.base, 'GET', `/uploads/${upload.upload_id}`)).json.upload;
  assert.deepEqual(mid.received, [0, 2]);
  assert.deepEqual(mid.missing, [1]);
  // 重复上传同一分块（内容一致）：幂等接受，不重复存储
  const dup = await putChunk(t.base, upload.upload_id, 2, chunks[2]);
  assert.equal(dup.status, 200);
  assert.equal(dup.json.result.status, 'duplicate');
  assert.equal((await putChunk(t.base, upload.upload_id, 1, chunks[1])).json.result.status, 'stored');
  const done = await api(t.base, 'POST', `/uploads/${upload.upload_id}/complete`);
  assert.equal(done.status, 200);
  assert.equal(done.json.file.sha256, sha256Hex(buf));
  const after = (await api(t.base, 'GET', `/uploads/${upload.upload_id}`)).json.upload;
  assert.equal(after.status, 'completed');
 } finally { await t.close(); }
});

test('分块摘要与校验值不符时被拒收', async () => {
 const t = await startServer();
 try {
  const buf = fileBytes('校验.bin', 70000);
  const upload = await createUpload(t.base, '校验.bin', buf, 65536);
  const bad = await putChunk(t.base, upload.upload_id, 0, buf.subarray(0, 65536), '0'.repeat(64));
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, 'CHUNK_DIGEST_MISMATCH');
  const st = (await api(t.base, 'GET', `/uploads/${upload.upload_id}`)).json.upload;
  assert.deepEqual(st.received, []);
 } finally { await t.close(); }
});

test('同一序号分块内容冲突时被拒绝', async () => {
 const t = await startServer();
 try {
  const buf = fileBytes('冲突.bin', 70000);
  const upload = await createUpload(t.base, '冲突.bin', buf, 65536);
  const chunks = splitChunks(buf, 65536);
  assert.equal((await putChunk(t.base, upload.upload_id, 0, chunks[0])).status, 200);
  const other = fileBytes('另一份内容.bin', 65536);
  const conflict = await putChunk(t.base, upload.upload_id, 0, other);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'CHUNK_CONFLICT');
 } finally { await t.close(); }
});

test('整包摘要不符：合并结果被废弃且会话关闭', async () => {
 const t = await startServer();
 try {
  const buf = fileBytes('整包.bin', 70000);
  const upload = await createUpload(t.base, '整包.bin', buf, 65536, 'f'.repeat(64));
  const chunks = splitChunks(buf, 65536);
  await putChunk(t.base, upload.upload_id, 0, chunks[0]);
  await putChunk(t.base, upload.upload_id, 1, chunks[1]);
  const done = await api(t.base, 'POST', `/uploads/${upload.upload_id}/complete`);
  assert.equal(done.status, 422);
  assert.equal(done.json.error.code, 'PACKAGE_DIGEST_MISMATCH');
  assert.equal(done.json.error.details.declared, 'f'.repeat(64));
  assert.equal(done.json.error.details.actual, sha256Hex(buf));
  // 会话关闭：不能继续传分块，也不能再次合并
  assert.equal((await putChunk(t.base, upload.upload_id, 0, chunks[0])).status, 409);
  assert.equal((await api(t.base, 'POST', `/uploads/${upload.upload_id}/complete`)).status, 409);
  const st = (await api(t.base, 'GET', `/uploads/${upload.upload_id}`)).json.upload;
  assert.equal(st.status, 'failed');
  assert.equal(st.failure.reason, '整包摘要不符');
  // 没有生成任何可封存内容
  assert.deepEqual(await readdir(join(t.storeDir, 'blobs')), []);
  assert.deepEqual((await api(t.base, 'GET', '/packages')).json.packages, []);
 } finally { await t.close(); }
});

test('分块未传齐时拒绝合并并返回缺失序号', async () => {
 const t = await startServer();
 try {
  const buf = fileBytes('未齐.bin', 150000);
  const upload = await createUpload(t.base, '未齐.bin', buf, 65536);
  const chunks = splitChunks(buf, 65536);
  await putChunk(t.base, upload.upload_id, 0, chunks[0]);
  const done = await api(t.base, 'POST', `/uploads/${upload.upload_id}/complete`);
  assert.equal(done.status, 409);
  assert.equal(done.json.error.code, 'CHUNKS_MISSING');
  assert.deepEqual(done.json.error.details.missing, [1, 2]);
 } finally { await t.close(); }
});

test('进程重启后上传会话可续传，中断不留半成品', async () => {
 const t = await startServer();
 try {
  const buf = fileBytes('续传.bin', 150000);
  const upload = await createUpload(t.base, '续传.bin', buf, 65536);
  const chunks = splitChunks(buf, 65536);
  await putChunk(t.base, upload.upload_id, 0, chunks[0]);
  await t.restart(); // 模拟进程中断后重启
  const st = (await api(t.base, 'GET', `/uploads/${upload.upload_id}`)).json.upload;
  assert.deepEqual(st.received, [0]);
  assert.deepEqual(st.missing, [1, 2]);
  // 中断期间没有任何可封存的半成品
  assert.deepEqual((await api(t.base, 'GET', '/packages')).json.packages, []);
  assert.deepEqual(await readdir(join(t.storeDir, 'blobs')), []);
  // 续传剩余分块并完成
  await putChunk(t.base, upload.upload_id, 1, chunks[1]);
  await putChunk(t.base, upload.upload_id, 2, chunks[2]);
  const done = await api(t.base, 'POST', `/uploads/${upload.upload_id}/complete`);
  assert.equal(done.status, 200);
  assert.equal(done.json.file.sha256, sha256Hex(buf));
 } finally { await t.close(); }
});
