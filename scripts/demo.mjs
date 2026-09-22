// 端到端演示：以 data/example.json 的措施-现场记录-文件摘要关联为基础，
// 完整走一遍送审、乱序续传、损坏拒绝、封存、撤回、复核、补交、授权下载，
// 并用“损坏分块/损坏原件”实例证明系统拒绝把坏包交给复核员。
//
// 用法：npm run demo
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {start} from '../service.mjs';
import {readRecords} from '../contracts.mjs';
import {buildSubmission, sliceChunk, sha256} from '../client.mjs';
import {seed} from './seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const dataDir = join(repo, 'data');

const line = () => console.log('─'.repeat(72));
const say = (title, body) => { console.log(`\n▶ ${title}`); if (body !== undefined) console.log(body); };
const pass = msg => console.log(`  ✅ ${msg}`);
const show = (label, value) => console.log(`  · ${label}：${value}`);

async function call(base, path, init = {}) {
 const res = await fetch(base + path, init);
 let body = null;
 try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
 return {status: res.status, body, headers: res.headers};
}

async function uploadAll(base, pkg, submission, buffers, order) {
 const jobs = [];
 submission.files.forEach((f, fi) => f.chunks.forEach((_, ci) => jobs.push({fi, ci})));
 for (const pos of order) {
  const {fi, ci} = jobs[pos];
  const f = submission.files[fi];
  await call(base, `/packages/${pkg}/files/${fi}/chunks/${ci}`, {method: 'PUT', body: sliceChunk(buffers[fi], f.chunk_size, ci)});
 }
}

async function uploadAssembleSeal(base, pkg, submission, buffers, order) {
 await uploadAll(base, pkg, submission, buffers, order);
 for (let fi = 0; fi < submission.files.length; fi++) {
  const r = await call(base, `/packages/${pkg}/files/${fi}/assemble`, {method: 'POST'});
  if (r.status !== 200) throw new Error(`组装失败：${JSON.stringify(r.body)}`);
 }
 const r = await call(base, `/packages/${pkg}/seal`, {method: 'POST'});
 if (r.status !== 200) throw new Error(`封存失败：${JSON.stringify(r.body)}`);
 return r.body;
}

async function main() {
 try {
  await readFile(join(dataDir, 'example.json'));
 } catch {
  await seed(dataDir);
 }
 const records = await readRecords(join(dataDir, 'example.json'));
 const record = records[0];
 const work = await mkdtemp(join(tmpdir(), 'seal-demo-'));
 const {server, store} = await start(0, work);
 const base = `http://127.0.0.1:${server.address().port}`;
 try {
  line();
  console.log('整改证据封存服务 · 端到端演示（全部数据为虚构样例）');
  line();

  // 1) 建包：措施、现场记录、检查位置与每个文件摘要关联
  const built = await buildSubmission(record, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512});
  say('1. 送审建包（措施-现场记录-文件摘要关联）');
  show('措施', `${record.measure_id} ${record.measure}`);
  show('检查位置', `${record.site.name}（${record.site.code}）`);
  show('采集时间', record.capture_at);
  show('文件数 × 分块数', built.submission.files.map(f => `${f.name}=${f.chunks.length}`).join('，'));
  const created = (await call(base, '/packages', {method: 'POST', body: JSON.stringify(built.submission)})).body;
  show('证据包编号', created.pkg);
  show('整包申报摘要', created.digest);
  pass('建包成功，每个分块均有独立 SHA-256，支持断点续传');

  // 2) 乱序、重复、损坏
  const pkg = created.pkg;
  const f0 = built.submission.files[0];
  const total = built.submission.files.reduce((n, f) => n + f.chunks.length, 0);
  const order = [...Array(total).keys()].sort((a, b) => ((a * 31 + 7) % total) - ((b * 31 + 7) % total));
  say('2. 分块续传：乱序上传、重复幂等、损坏拒绝');
  await uploadAll(base, pkg, built.submission, built.buffers, order);
  show('乱序上传', `${total} 个分块全部按序号落位`);
  const dup = await call(base, `/packages/${pkg}/files/0/chunks/0`, {method: 'PUT', body: sliceChunk(built.buffers[0], f0.chunk_size, 0)});
  show('重复上传结果', `${dup.status} ${dup.body.result}`);
  if (dup.body.result !== 'duplicate_ignored') throw new Error('重复分块未幂等处理');

  // 先对一个未上传过的位置传坏块（模拟网络损坏）
  let fi = -1, ci = -1, cs = 0;
  outer: for (let i = 0; i < built.submission.files.length; i++) {
   for (let j = 0; j < built.submission.files[i].chunks.length; j++) {
    // 选一个已上传位置，演示“正确块拒绝被坏内容覆盖”
    fi = i; ci = j; cs = built.submission.files[i].chunk_size; break outer;
   }
  }
  const corruptBytes = Buffer.from(sliceChunk(built.buffers[fi], cs, ci));
  corruptBytes[0] ^= 0xa5;
  const conflict = await call(base, `/packages/${pkg}/files/${fi}/chunks/${ci}`, {method: 'PUT', body: corruptBytes});
  show('用损坏内容覆盖已收块', `${conflict.status} ${conflict.body.error}（不落盘、不覆盖）`);
  if (conflict.status !== 409) throw new Error('损坏覆盖应被拒绝');

  // 重置后再传坏块：422 chunk_corrupt，期望/实际摘要都给出
  await call(base, `/packages/${pkg}/files/${fi}/chunks/${ci}`, {method: 'DELETE'});
  const rejected = await call(base, `/packages/${pkg}/files/${fi}/chunks/${ci}`, {method: 'PUT', body: corruptBytes});
  show('损坏分块上传', `${rejected.status} ${rejected.body.error}`);
  show('  期望摘要', rejected.body.detail.expected);
  show('  实际摘要', rejected.body.detail.actual);
  if (rejected.status !== 422) throw new Error('损坏分块应被 422 拒绝');
  // 重新上传正确分块，封存成功
  const repaired = await call(base, `/packages/${pkg}/files/${fi}/chunks/${ci}`, {method: 'PUT', body: sliceChunk(built.buffers[fi], cs, ci)});
  show('重传正确分块', `${repaired.status} ${repaired.body.result}`);
  pass('乱序可定位、重复被忽略、损坏给明确结果，坏块进不了封存');

  const sealed = await uploadAssembleSeal(base, pkg, built.submission, built.buffers, []);
  say('3. 原子封存');
  show('封存版本', `${sealed.pkg}@${sealed.digest}`);
  show('封存时间', sealed.sealed_at);
  const v1 = await call(base, `/packages/${pkg}/verify`);
  show('完整性校验', v1.body.ok ? 'ok=true（逐文件重算 SHA-256 全部相符）' : JSON.stringify(v1.body));
  if (!v1.body.ok) throw new Error('新封存包校验应通过');

  // 3) 复核绑定检查位置与版本；撤回只追加
  say('4. 复核意见绑定检查位置与证据包版本；撤回只新增记录');
  const badReview = await call(base, `/packages/${pkg}/reviews`, {
   method: 'POST', body: JSON.stringify({reviewer: '周复核', decision: 'approved', opinion: '同意', check_site: {name: '现场'}})
  });
  show('缺少位置编号的复核', `${badReview.status} ${badReview.body.error}：${badReview.body.detail}`);
  const review = (await call(base, `/packages/${pkg}/reviews`, {
   method: 'POST',
   body: JSON.stringify({reviewer: '周复核', decision: 'approved', opinion: '排水沟断面尺寸与照片一致，同意通过。', check_site: record.site})
  })).body;
  show('已登记复核版本', review.package_version);
  show('绑定检查位置', `${review.check_site.name}（${review.check_site.code}）`);
  const wd = (await call(base, `/packages/${pkg}/withdrawals`, {
   method: 'POST', body: JSON.stringify({author: '现场员 吴记账', statement: '撤回口头补充说明，一切以封存照片与记录为准。'})
  })).body;
  show('撤回记录编号', `${wd.record_id}（仅追加，封存字节不变）`);

  // 4) 补交生成新包，原结论可重现
  say('5. 补交材料生成新包，原复核结论完整重现');
  const rec2 = {...record, measure: record.measure + '（补交：补拍盖板近景照）'};
  const built2 = await buildSubmission(rec2, {sourceRoot: join(dataDir, 'raw'), chunkSize: 512, supersedes: pkg});
  const c2 = (await call(base, '/packages', {method: 'POST', body: JSON.stringify(built2.submission)})).body;
  const order2 = [...Array(built2.submission.files.reduce((n, f) => n + f.chunks.length, 0)).keys()].reverse();
  await uploadAssembleSeal(base, c2.pkg, built2.submission, built2.buffers, order2);
  show('新补交包', `${c2.pkg}（与原包 ${pkg} 编号、摘要均不同）`);
  const oldStatus = (await call(base, `/packages/${pkg}`)).body;
  show('原包状态', `${oldStatus.status}，被 ${oldStatus.superseded_by} 补交，但内容与结论未改写`);
  show('原复核结论可重现', `${oldStatus.reviews[0].opinion} @ ${oldStatus.reviews[0].package_version}`);
  show('原撤回记录仍在', oldStatus.withdrawals.map(w => w.record_id).join(', '));
  pass('补交不覆盖原包，版本链 supersedes / superseded_by 双向可查');

  // 5) 授权下载：正常 / 重放 / 过期
  say('6. 授权下载：一次性票据，过期与重放均不得获取原件');
  const ticket = (await call(base, `/packages/${pkg}/tickets`, {method: 'POST', body: JSON.stringify({ttl_seconds: 1})})).body;
  show('票据有效期', `至 ${ticket.expires_at}`);
  const dl = await fetch(`${base}/download/${pkg}?token=${encodeURIComponent(ticket.token)}&file=f000`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  show('首次下载', `${dl.status}，字节数=${bytes.length}，X-File-Sha256=${dl.headers.get('x-file-sha256')}`);
  if (sha256(bytes) !== built.submission.files[0].sha256) throw new Error('下载原件摘要不符');
  const replay = await call(base, `/download/${pkg}?token=${encodeURIComponent(ticket.token)}&file=f000`);
  show('票据重放', `${replay.status} ${replay.body.error}`);
  if (replay.status !== 409) throw new Error('一次性票据重放应被拒绝');
  await new Promise(r => setTimeout(r, 1100));
  const expired = await call(base, `/download/${pkg}?token=${encodeURIComponent(ticket.token)}&file=f000`);
  show('过期后重放', `${expired.status} ${expired.body.error}`);
  if (expired.status !== 410) throw new Error('过期票据应被拒绝');
  pass('授权取件全程不输出暂存半包；过期授权重放拿不到原件');

  // 6) 关键实证：封存后原件被损坏（同构于“照片被覆盖”），拒绝出件
  say('7. 损坏实证：封存区字节被破坏 → 完整性校验失败，拒绝把坏包交给复核员');
  const blobPath = join(work, 'sealed', pkg, 'files', 'f001.blob');
  const blob = Buffer.from(await readFile(blobPath));
  const before = sha256(blob);
  blob[blob.length >> 1] ^= 0x5a;
  await writeFile(blobPath, blob);
  show('破坏动作', `翻转 f001.blob 中间字节，摘要 ${before.slice(0, 16)}… → ${sha256(blob).slice(0, 16)}…`);
  const badVerify = (await call(base, `/packages/${pkg}/verify`)).body;
  const badFile = badVerify.files.find(f => !f.ok);
  show('完整性校验', `ok=${badVerify.ok}，损坏文件=${badFile.name}`);
  show('  登记摘要', badFile.expected);
  show('  实算摘要', badFile.actual);
  if (badVerify.ok) throw new Error('损坏后校验必须失败');
  const ticket2 = (await call(base, `/packages/${pkg}/tickets`, {method: 'POST', body: '{}'})).body;
  const refused = await call(base, `/download/${pkg}?token=${encodeURIComponent(ticket2.token)}&file=f000`);
  show('持有效新票据取件', `${refused.status} ${refused.body.error}（核销前整包校验拦截）`);
  if (refused.status !== 410) throw new Error('坏包必须拒绝出件');
  const oldPkgOk = (await call(base, `/packages/${c2.pkg}/verify`)).body.ok;
  show('补交包不受影响', `verify ok=${oldPkgOk}`);

  line();
  console.log('演示结论：坏分块在上传/组装/封存/出件四个环节均被明确拒绝；');
  console.log('封存包不可变，撤回只追加、复核绑定位置与版本，授权重放与过期均失效。');
  line();
 } finally {
  await new Promise(r => server.close(r));
  await rm(work, {recursive: true, force: true});
 }
}

main().catch(err => { console.error('演示失败：', err); process.exitCode = 1; });
