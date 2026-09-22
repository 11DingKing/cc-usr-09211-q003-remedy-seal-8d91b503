// 送审端辅助：读取原件、计算分块/整文件摘要、按任意顺序续传。
// 仅用于样例、测试与演示；生产现场端按相同约定实现即可。
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

// 按定长切分原件（最后一块取余长），得到分块摘要清单。
export function planChunks(buffer, chunkSize) {
 const chunks = [];
 for (let offset = 0; offset < buffer.length; offset += chunkSize) {
  chunks.push(sha256(buffer.subarray(offset, offset + chunkSize)));
 }
 return chunks;
}

// 以业务样例记录为基础构造送审输入：措施、现场记录、检查位置与文件摘要关联。
export async function buildSubmission(record, {sourceRoot, chunkSize = 64 * 1024, supersedes = null} = {}) {
 const files = [];
 const buffers = [];
 for (const f of record.files) {
  const buf = await readFile(join(sourceRoot, f.path));
  if (buf.length !== f.size || sha256(buf) !== f.sha256) throw new Error(`原件与样例摘要不符：${f.path}`);
  const chunks = planChunks(buf, chunkSize);
  files.push({
   name: f.name, path: f.path, size: buf.length, sha256: sha256(buf),
   chunk_size: chunkSize, chunks, media: f.media ?? null, role: f.role ?? null
  });
  buffers.push(buf);
 }
 return {
  submission: {
   measure_id: record.measure_id,
   measure: record.measure,
   site: record.site,
   capture_at: record.capture_at,
   supersedes,
   files
  },
  buffers
 };
}

export const sliceChunk = (buf, chunkSize, index) => {
 const start = index * chunkSize;
 return buf.subarray(start, Math.min(start + chunkSize, buf.length));
};

// 按给定顺序上传全部分块（可乱序、可插入损坏块）。
export async function uploadChunks(base, pkg, submission, buffers, {
 order = null, corrupt = null, onResult = () => {}
} = {}) {
 const jobs = [];
 for (let fi = 0; fi < submission.files.length; fi++) {
  const total = submission.files[fi].chunks.length;
  for (let ci = 0; ci < total; ci++) jobs.push({fi, ci});
 }
 const seq = order ?? jobs.map((_, i) => i);
 for (const pos of seq) {
  const {fi, ci} = jobs[pos];
  let bytes = sliceChunk(buffers[fi], submission.files[fi].chunk_size, ci);
  if (corrupt && corrupt.file_index === fi && corrupt.chunk_index === ci) bytes = corrupt.with;
  const res = await fetch(`${base}/packages/${pkg}/files/${fi}/chunks/${ci}`, {method: 'PUT', body: bytes});
  let body;
  try { body = await res.json(); } catch { body = null; }
  onResult({fi, ci, status: res.status, body});
 }
}
