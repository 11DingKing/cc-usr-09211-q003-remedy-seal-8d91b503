import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readRecords} from '../contracts.mjs';
import {sampleRecords} from '../sample.mjs';
import {makeServer} from '../service.mjs';
test('业务样例往返保持原值', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'record-'));
 try {
  const file = join(dir, 'example.json');
  const rows = sampleRecords();
  await writeFile(file, JSON.stringify(rows, null, 2));
  assert.deepEqual(await readRecords(file), rows);
 } finally { await rm(dir, {recursive: true, force: true}); }
});
test('不完整记录被拒绝', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'record-'));
 try { const file = join(dir, 'bad.json'); await writeFile(file, '[{}]'); await assert.rejects(readRecords(file)); } finally {await rm(dir, {recursive: true});}
});
test('健康探针与未知地址', async () => {
 const server = makeServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {const base = `http://127.0.0.1:${server.address().port}`; assert.deepEqual(await (await fetch(base + '/health')).json(), {status:'ok'}); assert.equal((await fetch(base + '/unknown')).status, 404);} finally {await new Promise(resolve => {server.close(resolve); server.closeAllConnections?.();});}
});
