import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRecords} from '../contracts.mjs';
import {Store} from '../store.mjs';
import {makeServer} from '../service.mjs';
import {buildSubmission, uploadChunks, sliceChunk} from '../client.mjs';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

async function harness() {
 const dir = await mkdtemp(join(tmpdir(), 'seal-'));
 const store = await Store.open(dir);
 const server = makeServer(store);
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 const base = `http://127.0.0.1:${server.address().port}`;
 const stop = async () => { await new Promise(r => server.close(r)); await rm(dir, {recursive: true, force: true}); };
 return {dir, store, server, base, stop};
}

async function loadRecord(i = 0) {
 const records = await readRecords(join(dataDir, 'example.json'));
 return records[i];
}

async function uploadAssembleSeal(base, pkg, submission, buffers, opts = {}) {
 await uploadChunks(base, pkg, submission, buffers, opts);
 for (let fi = 0; fi < submission.files.length; fi++) {
  const r = await fetch(`${base}/packages/${pkg}/files/${fi}/assemble`, {method: 'POST'});
  const text = await r.text();
  assert.equal(r.status, 200, `文件${fi} assemble: ${text}`);
 }
 const r = await fetch(`${base}/packages/${pkg}/seal`, {method: 'POST'});
 const text = await r.text();
 assert.equal(r.status, 200, `seal: ${text}`);
 return JSON.parse(text);
}

test('业务样例往返保持原值', async () => {
 const url = join(dataDir, 'example.json');
 assert.deepEqual(await readRecords(url), JSON.parse(await readFile(url, 'utf8')));
});

test('不完整记录被拒绝', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'record-'));
 try {
  const file = join(dir, 'bad.json');
  await writeFile(file, '[{}]');
  await assert.rejects(readRecords(file));
 } finally { await rm(dir, {recursive: true}); }
});

test('乱序上传、重复幂等、损坏分块被明确拒绝', async () => {
 const h = await harness();
 try {
  const record = await loadRecord(0);
  const {submission, buffers} = await buildSubmission(record, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});
  const created = await (await fetch(`${h.base}/packages`, {method: 'POST', body: JSON.stringify(submission)})).json();
  const pkg = created.pkg;

  // 构造乱序顺序：把所有分块任务倒序并打乱奇偶。
  const jobs = [];
  submission.files.forEach((f, fi) => f.chunks.forEach((_, ci) => jobs.push({fi, ci})));
  const order = jobs.map((_, i) => i).sort((a, b) => ((a * 7 + 3) % jobs.length) - ((b * 7 + 3) % jobs.length));

  const results = [];
  await uploadChunks(h.base, pkg, submission, buffers, {order, onResult: r => results.push(r)});
  assert.ok(results.every(r => r.status === 200));

  // 重复上传同一块：幂等忽略，不覆盖。
  const dup = await fetch(`${h.base}/packages/${pkg}/files/0/chunks/0`, {method: 'PUT', body: buffers[0].subarray(0, 512)});
  assert.equal(dup.status, 200);
  assert.equal((await dup.json()).result, 'duplicate_ignored');

  // 损坏分块（翻转一字节）：先重置该块，再传坏内容 → 422，明确给出期望/实际摘要。
  await fetch(`${h.base}/packages/${pkg}/files/0/chunks/1`, {method: 'DELETE'});
  const cs = submission.files[0].chunk_size;
  const bad = Buffer.from(sliceChunk(buffers[0], cs, 1));
  bad[0] ^= 0xff;
  const corrupt = await fetch(`${h.base}/packages/${pkg}/files/0/chunks/1`, {method: 'PUT', body: bad});
  assert.equal(corrupt.status, 422);
  const body = await corrupt.json();
  assert.equal(body.error, 'chunk_corrupt');
  assert.ok(body.detail.expected !== body.detail.actual);

  // 已正确接收的块再传损坏内容：409 冲突，拒绝覆盖。
  const conflict = await fetch(`${h.base}/packages/${pkg}/files/0/chunks/0`, {method: 'PUT', body: bad});
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'chunk_conflict');

  // 续传状态：损坏块未落盘，缺失分块可查询。
  const status = await (await fetch(`${h.base}/packages/${pkg}`)).json();
  assert.equal(status.status, 'open');
  assert.ok(status.files[0].missing_chunks.includes(1));

  // 重新上传正确分块后完成封存。
  const repair = await fetch(`${h.base}/packages/${pkg}/files/0/chunks/1`, {method: 'PUT', body: sliceChunk(buffers[0], cs, 1)});
  assert.equal(repair.status, 200);
  assert.equal((await repair.json()).result, 'stored');

  for (let fi = 0; fi < submission.files.length; fi++) {
   const r = await fetch(`${h.base}/packages/${pkg}/files/${fi}/assemble`, {method: 'POST'});
   assert.equal(r.status, 200);
  }
  const seal = await fetch(`${h.base}/packages/${pkg}/seal`, {method: 'POST'});
  assert.equal(seal.status, 200);

  // 已封存包拒绝再传分块。
  const after = await fetch(`${h.base}/packages/${pkg}/files/0/chunks/1`, {method: 'PUT', body: bad});
  assert.equal(after.status, 409);
  assert.equal((await after.json()).error, 'already_sealed');
 } finally { await h.stop(); }
});

test('文件整摘要不符：组装阶段拒绝，封存不会发生', async () => {
 const h = await harness();
 try {
  const record = await loadRecord(1);
  const {submission, buffers} = await buildSubmission(record, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});
  // 申报的整文件摘要故意写错（分块摘要仍正确）。
  submission.files[1].sha256 = '0'.repeat(64);
  const created = await (await fetch(`${h.base}/packages`, {method: 'POST', body: JSON.stringify(submission)})).json();
  const pkg = created.pkg;
  await uploadChunks(h.base, pkg, submission, buffers);
  const okFile = await fetch(`${h.base}/packages/${pkg}/files/0/assemble`, {method: 'POST'});
  assert.equal(okFile.status, 200);
  const bad = await fetch(`${h.base}/packages/${pkg}/files/1/assemble`, {method: 'POST'});
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error, 'file_digest_mismatch');
  const seal = await fetch(`${h.base}/packages/${pkg}/seal`, {method: 'POST'});
  assert.equal(seal.status, 422);
  assert.equal((await seal.json()).error, 'incomplete_files');
 } finally { await h.stop(); }
});

test('整包摘要不符：封存阶段拒绝', async () => {
 const h = await harness();
 try {
  const record = await loadRecord(0);
  const {submission, buffers} = await buildSubmission(record, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});
  const created = await (await fetch(`${h.base}/packages`, {method: 'POST', body: JSON.stringify(submission)})).json();
  await uploadChunks(h.base, created.pkg, submission, buffers);
  for (let fi = 0; fi < submission.files.length; fi++) {
   await fetch(`${h.base}/packages/${created.pkg}/files/${fi}/assemble`, {method: 'POST'});
  }
  // 模拟封存前内存索引被篡改导致整包摘要漂移。
  h.store.pkgs.get(created.pkg).digest = 'f'.repeat(64);
  await assert.rejects(h.store.seal(created.pkg), e => e.code === 'package_digest_mismatch');
 } finally { await h.stop(); }
});

test('进程中断后可续传；半包中转目录重启即清除；封存改名落地可恢复', async () => {
 const h = await harness();
 try {
  const record = await loadRecord(2);
  const {submission, buffers} = await buildSubmission(record, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});

  // 场景一：传到一半“进程中断”，重新打开存储后状态仍在、可续传。
  let created = await h.store.createPackage(submission);
  const pkg = created.pkg;
  await h.store.putChunk(pkg, 0, 0, buffers[0].subarray(0, 512));
  const reopened = await Store.open(h.dir);
  const mid = await reopened.getStatus(pkg);
  assert.equal(mid.status, 'open');
  assert.deepEqual(mid.files[0].received_chunks, [0]);
  assert.ok(mid.files[0].missing_chunks.length > 0);

  // 场景二：遗留的 sealed/*.tmp-* 半包不得保留、不可下载。
  const {mkdir, writeFile: wf} = await import('node:fs/promises');
  await mkdir(join(h.dir, 'sealed', `${pkg}.tmp-9999-deadbeef`, 'files'), {recursive: true});
  await wf(join(h.dir, 'sealed', `${pkg}.tmp-9999-deadbeef`, 'files', 'half.blob'), 'half');
  const reopened2 = await Store.open(h.dir);
  const left = await readdir(join(h.dir, 'sealed'));
  assert.ok(!left.some(n => n.includes('.tmp-')), '半包中转目录必须被对账清除');

  // 场景三：续传完成并封存。
  const server2 = makeServer(reopened2);
  await new Promise(r => server2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  try {
   await uploadAssembleSeal(base2, pkg, submission, buffers);
  } finally { await new Promise(r => server2.close(r)); }

  // 场景四：封存改名已落地但事件日志缺封存行，重启后仍恢复为 sealed。
  const events = await readFile(join(h.dir, 'events.log'), 'utf8');
  const kept = events.split('\n').filter(l => l && !l.includes(`"type":"package_sealed","pkg":"${pkg}"`)).join('\n');
  await writeFile(join(h.dir, 'events.log'), kept);
  const reopened3 = await Store.open(h.dir);
  assert.equal(reopened3.pkgs.get(pkg).status, 'sealed');
  // 暂存区中的半包永不可下载：下载接口只认封存区，未封存包无法签票。
  const fresh = await harness();
  try {
   const c2 = await fresh.store.createPackage(JSON.parse(JSON.stringify(submission)));
   await assert.rejects(fresh.store.issueTicket(c2.pkg), e => e.code === 'not_sealed');
  } finally { await fresh.stop(); }
 } finally { await h.stop(); }
});

test('撤回只追加记录，不改写封存包；复核意见绑定检查位置与版本', async () => {
 const h = await harness();
 try {
  const record = await loadRecord(0);
  const {submission, buffers} = await buildSubmission(record, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});
  const created = await (await fetch(`${h.base}/packages`, {method: 'POST', body: JSON.stringify(submission)})).json();
  const sealed = await uploadAssembleSeal(h.base, created.pkg, submission, buffers);

  // 复核缺少检查位置：拒绝。
  const noSite = await fetch(`${h.base}/packages/${created.pkg}/reviews`, {
   method: 'POST', body: JSON.stringify({reviewer: '周复核', decision: 'approved', opinion: '同意', check_site: {name: '仅文字地点'}})
  });
  assert.equal(noSite.status, 400);

  const reviewBody = {
   reviewer: '周复核', decision: 'approved', opinion: '排水沟断面尺寸与照片一致，同意通过。',
   check_site: record.site
  };
  const rv = await fetch(`${h.base}/packages/${created.pkg}/reviews`, {method: 'POST', body: JSON.stringify(reviewBody)});
  assert.equal(rv.status, 201);
  const review = await rv.json();
  assert.equal(review.package_version, `${created.pkg}@${sealed.digest}`);
  assert.equal(review.check_site.code, record.site.code);

  // 现场撤回说明：追加撤回记录。
  const wd = await fetch(`${h.base}/packages/${created.pkg}/withdrawals`, {
   method: 'POST', body: JSON.stringify({author: '现场员 吴记账', statement: '撤回“已通电试亮”的口头说明，以封存照片为准。'})
  });
  assert.equal(wd.status, 201);
  const withdrawal = await wd.json();
  assert.match(withdrawal.record_id, /^WD-\d{4}$/);

  const lines = (await readFile(join(h.dir, 'sealed', created.pkg, 'records.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'review');
  assert.equal(lines[1].type, 'withdrawal');

  // 封存清单与文件字节未因撤回/复核改变。
  const verify = await (await fetch(`${h.base}/packages/${created.pkg}/verify`)).json();
  assert.equal(verify.ok, true);
  assert.equal(verify.digest, sealed.digest);

  // 状态中可完整重现当时结论与撤回记录。
  const status = await (await fetch(`${h.base}/packages/${created.pkg}`)).json();
  assert.equal(status.reviews.length, 1);
  assert.equal(status.withdrawals.length, 1);
 } finally { await h.stop(); }
});

test('补交材料生成新包，原复核结论仍完整重现', async () => {
 const h = await harness();
 try {
  const record = await loadRecord(0);
  const first = await buildSubmission(record, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});
  const c1 = await (await fetch(`${h.base}/packages`, {method: 'POST', body: JSON.stringify(first.submission)})).json();
  const s1 = await uploadAssembleSeal(h.base, c1.pkg, first.submission, first.buffers);
  const rv = await fetch(`${h.base}/packages/${c1.pkg}/reviews`, {
   method: 'POST',
   body: JSON.stringify({reviewer: '周复核', decision: 'approved', opinion: '初版同意通过。', check_site: record.site})
  });
  assert.equal(rv.status, 201);

  // 补交：新包声明 supersedes，摘要不同、编号不同。
  const secondRec = {...record, measure: record.measure + '（补交：补拍盖板近景）'};
  const second = await buildSubmission(secondRec, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512, supersedes: c1.pkg});
  const c2 = await (await fetch(`${h.base}/packages`, {method: 'POST', body: JSON.stringify(second.submission)})).json();
  assert.notEqual(c2.pkg, c1.pkg);
  assert.notEqual(c2.digest, s1.digest);
  await uploadAssembleSeal(h.base, c2.pkg, second.submission, second.buffers);

  // 原包未被改写，原结论仍绑定原版本可重现；版本链双向可查。
  const oldStatus = await (await fetch(`${h.base}/packages/${c1.pkg}`)).json();
  assert.equal(oldStatus.status, 'sealed');
  assert.equal(oldStatus.superseded_by, c2.pkg);
  assert.equal(oldStatus.reviews[0].package_version, `${c1.pkg}@${s1.digest}`);
  assert.equal(oldStatus.reviews[0].opinion, '初版同意通过。');
  const verifyOld = await (await fetch(`${h.base}/packages/${c1.pkg}/verify`)).json();
  assert.equal(verifyOld.ok, true);
  const newStatus = await (await fetch(`${h.base}/packages/${c2.pkg}`)).json();
  assert.equal(newStatus.supersedes, c1.pkg);
 } finally { await h.stop(); }
});

test('授权下载：正常取件，过期与重放均不得获取原件', async () => {
 const h = await harness();
 try {
  const record = await loadRecord(1);
  const {submission, buffers} = await buildSubmission(record, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});
  const created = await (await fetch(`${h.base}/packages`, {method: 'POST', body: JSON.stringify(submission)})).json();
  await uploadAssembleSeal(h.base, created.pkg, submission, buffers);

  const issue = await fetch(`${h.base}/packages/${created.pkg}/tickets`, {method: 'POST', body: JSON.stringify({ttl_seconds: 1})});
  assert.equal(issue.status, 201);
  const ticket = await issue.json();

  const dl = await fetch(`${h.base}/download/${created.pkg}?token=${encodeURIComponent(ticket.token)}&file=f000`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('x-file-sha256'), submission.files[0].sha256);
  const got = Buffer.from(await dl.arrayBuffer());
  assert.ok(got.equals(buffers[0]));

  // 重放：一次性票据已核销。
  const replay = await fetch(`${h.base}/download/${created.pkg}?token=${encodeURIComponent(ticket.token)}&file=f000`);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'ticket_replayed');

  // 等待票据绝对过期后，同样的票据不能取件。
  await new Promise(r => setTimeout(r, 1100));
  const expired = await fetch(`${h.base}/download/${created.pkg}?token=${encodeURIComponent(ticket.token)}&file=f000`);
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error, 'ticket_expired');

  // 篡改票据签名：直接拒绝。
  const tampered = ticket.token.slice(0, -2) + (ticket.token.endsWith('aa') ? 'bb' : 'aa');
  const badSig = await fetch(`${h.base}/download/${created.pkg}?token=${encodeURIComponent(tampered)}&file=f000`);
  assert.equal(badSig.status, 401);

  // 票据跨包使用：拒绝。
  const other = await buildSubmission(await loadRecord(2), {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});
  const c2 = await (await fetch(`${h.base}/packages`, {method: 'POST', body: JSON.stringify(other.submission)})).json();
  await uploadAssembleSeal(h.base, c2.pkg, other.submission, other.buffers);
  const t2 = await (await fetch(`${h.base}/packages/${c2.pkg}/tickets`, {method: 'POST', body: '{}'})).json();
  const cross = await fetch(`${h.base}/download/${created.pkg}?token=${encodeURIComponent(t2.token)}&file=f000`);
  assert.equal(cross.status, 401);
  assert.equal((await cross.json()).error, 'ticket_scope_mismatch');
 } finally { await h.stop(); }
});

test('损坏分块实证：封存后字节被损坏，完整性校验失败且拒绝出件给复核员', async () => {
 const h = await harness();
 try {
  const record = await loadRecord(2);
  const {submission, buffers} = await buildSubmission(record, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});
  const created = await (await fetch(`${h.base}/packages`, {method: 'POST', body: JSON.stringify(submission)})).json();
  await uploadAssembleSeal(h.base, created.pkg, submission, buffers);

  // 复核员先拿到完整校验通过结论。
  let report = await h.store.verify(created.pkg);
  assert.equal(report.ok, true);

  // 模拟磁盘损坏/被替换：翻转封存区某文件中的一个字节（与“照片被覆盖”同构）。
  const blobPath = join(h.dir, 'sealed', created.pkg, 'files', 'f001.blob');
  const blob = Buffer.from(await readFile(blobPath));
  blob[blob.length >> 1] ^= 0x5a;
  await writeFile(blobPath, blob);

  report = await h.store.verify(created.pkg);
  assert.equal(report.ok, false);
  const bad = report.files.find(f => !f.ok);
  assert.ok(bad, '应报告具体损坏文件');
  assert.notEqual(bad.actual, bad.expected);

  // 即使持有有效新票据，核销前校验拦截：坏包绝不交给复核员。
  const ticket = await h.store.issueTicket(created.pkg, 60);
  await assert.rejects(h.store.redeem(ticket.token), e => e.status === 410 && e.code === 'package_corrupt');
 } finally { await h.stop(); }
});

test('重置分块后“崩溃”不误判已收；事件日志缺失时撤回/复核从封存包恢复', async () => {
 const h = await harness();
 try {
  const record = await loadRecord(0);
  const {submission, buffers} = await buildSubmission(record, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});
  const created = await h.store.createPackage(submission);
  const pkg = created.pkg;
  // 上传两块后重置第二块，模拟重置事件刚落盘进程即退出。
  const cs = submission.files[0].chunk_size;
  await h.store.putChunk(pkg, 0, 0, sliceChunk(buffers[0], cs, 0));
  await h.store.putChunk(pkg, 0, 1, sliceChunk(buffers[0], cs, 1));
  await h.store.resetChunk(pkg, 0, 1);
  const reopened = await Store.open(h.dir);
  const st = await reopened.getStatus(pkg);
  assert.deepEqual(st.files[0].received_chunks, [0]);
  assert.ok(st.files[0].missing_chunks.includes(1));
  assert.equal(st.files[0].assembled, false);
 } finally { await h.stop(); }
});

test('撤回与复核记录以封存包 records.jsonl 为权威，事件丢失仍可重现', async () => {
 const h = await harness();
 try {
  const record = await loadRecord(1);
  const {submission, buffers} = await buildSubmission(record, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});
  const created = await h.store.createPackage(submission);
  await uploadAssembleSeal(h.base, created.pkg, submission, buffers);
  await fetch(`${h.base}/packages/${created.pkg}/reviews`, {
   method: 'POST',
   body: JSON.stringify({reviewer: '郑复核', decision: 'returned', opinion: '请补拍灯杆编号。', check_site: record.site})
  }).then(r => assert.equal(r.status, 201));
  await fetch(`${h.base}/packages/${created.pkg}/withdrawals`, {
   method: 'POST', body: JSON.stringify({author: '现场员 吴记账', statement: '撤回“12 盏全部合格”的口头说法。'})
  }).then(r => assert.equal(r.status, 201));

  // 清空事件日志（极端损坏），封存包内记录仍能重建结论。
  await writeFile(join(h.dir, 'events.log'), '');
  const reopened = await Store.open(h.dir);
  const status = await reopened.getStatus(created.pkg);
  assert.equal(status.status, 'sealed');
  assert.equal(status.reviews.length, 1);
  assert.equal(status.reviews[0].decision, 'returned');
  assert.equal(status.reviews[0].check_site.code, record.site.code);
  assert.equal(status.withdrawals.length, 1);
  assert.match(status.withdrawals[0].statement, /撤回/);
 } finally { await h.stop(); }
});

test('健康探针与未知地址', async () => {
 const h = await harness();
 try {
  assert.deepEqual(await (await fetch(h.base + '/health')).json(), {status: 'ok'});
  assert.equal((await fetch(h.base + '/unknown')).status, 404);
 } finally { await h.stop(); }
});
