import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store, sha256Hex, canonicalize, manifestCore, packageIdOf} from '../store.mjs';
import {fileBytes} from '../sample.mjs';
import {makeServer} from '../service.mjs';

test('封存过程中进程崩溃不留下可下载的半包', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'seal-crash-'));
 try {
  const storeDir = join(dir, 'store');
  // 父进程先完成一次真实分块上传，产生可封存的 blob
  const buf = fileBytes('崩溃现场.jpg', 150000);
  const prep = new Store(storeDir);
  const up = await prep.createUpload({name: '崩溃现场.jpg', size: buf.length, chunk_size: 65536, sha256: sha256Hex(buf)});
  const chunks = [buf.subarray(0, 65536), buf.subarray(65536, 131072), buf.subarray(131072)];
  for (let i = 0; i < chunks.length; i++) await prep.uploadChunk(up.upload_id, i, chunks[i], sha256Hex(chunks[i]));
  await prep.completeUpload(up.upload_id);
  const input = {
   measure_id: 'ZL-2026-200', site: '虚构地点', capture_at: '2026-09-15T11:00:00+08:00',
   submitted_by: '送审员甲', files: [{name: '崩溃现场.jpg', sha256: sha256Hex(buf), size: buf.length}],
  };
  // 子进程在 rename 之后、登记日志写入之前崩溃（afterRename 钩子触发 process.exit）
  const fixture = fileURLToPath(new URL('./fixtures/crash-seal.mjs', import.meta.url));
  await new Promise((resolve, reject) => {
   execFile(process.execPath, [fixture, storeDir, JSON.stringify(input)], (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve({stdout, stderr}));
  });
  // 崩溃现场：磁盘上留下了一个未登记的半包目录
  const core = manifestCore({...input, version: 1, previous: null});
  const orphanId = packageIdOf(sha256Hex(Buffer.from(canonicalize(core), 'utf8')));
  assert.deepEqual(await readdir(join(storeDir, 'packages')), [orphanId]);
  // 重启：启动清扫移除半包，登记日志中没有它
  const store = new Store(storeDir);
  const {swept} = await store.init();
  assert.deepEqual(swept, [orphanId]);
  assert.deepEqual(await readdir(join(storeDir, 'packages')), []);
  // 半包通过任何接口都拿不到
  const server = makeServer({storeDir});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
   const base = `http://127.0.0.1:${server.address().port}`;
   assert.equal((await fetch(`${base}/packages/${orphanId}`)).status, 404);
   assert.deepEqual((await (await fetch(`${base}/packages`)).json()).packages, []);
   const g = await fetch(`${base}/packages/${orphanId}/grants`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({file: '崩溃现场.jpg', ttl_seconds: 60})});
   assert.equal(g.status, 404);
  } finally {
   await new Promise(r => { server.close(r); server.closeAllConnections?.(); });
  }
 } finally {
  await rm(dir, {recursive: true, force: true});
 }
});
