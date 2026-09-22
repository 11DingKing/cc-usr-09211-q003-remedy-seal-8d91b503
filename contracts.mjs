// 业务数据结构与封存清单约定。
// 文件摘要使用 SHA-256，采集时间保留原偏移；地点为虚构示例。
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export const fields = ['measure_id', 'site', 'files', 'capture_at'];

// 现场记录与措施、文件摘要关联的最小字段集合。
const fileFields = ['name', 'path', 'size', 'sha256'];

export async function readRecords(path) {
 const rows = JSON.parse(await readFile(path, 'utf8'));
 if (!Array.isArray(rows)) throw new TypeError('记录集合必须是数组');
 for (const row of rows) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || fields.some(key => !Object.hasOwn(row, key))) throw new TypeError('记录字段不完整');
 }
 return structuredClone(rows);
}

const isStr = v => typeof v === 'string' && v.trim().length > 0;
const isHash = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

// 检查位置：复核意见必须绑定到具体检查位置，不允许只写“现场”。
export function validateSite(site) {
 if (!site || typeof site !== 'object' || Array.isArray(site)) return '检查位置必须是对象';
 if (!isStr(site.name)) return '检查位置名称缺失';
 if (!isStr(site.code)) return '检查位置编号缺失';
 if (site.longitude !== undefined && (typeof site.longitude !== 'number' || !Number.isFinite(site.longitude))) return '经度必须是数值';
 if (site.latitude !== undefined && (typeof site.latitude !== 'number' || !Number.isFinite(site.latitude))) return '纬度必须是数值';
 return null;
}

// 送审文件申报项：名称、字节数、整文件 SHA-256、分块大小。
export function validateFileEntry(file, index) {
 const where = `文件${index + 1}`;
 if (!file || typeof file !== 'object' || Array.isArray(file)) return `${where}必须是对象`;
 for (const key of fileFields) if (!Object.hasOwn(file, key)) return `${where}缺少字段 ${key}`;
 if (!isStr(file.name)) return `${where}名称缺失`;
 if (!isStr(file.path)) return `${where}来源路径缺失`;
 if (!Number.isInteger(file.size) || file.size <= 0) return `${where}字节数必须是正整数`;
 if (!isHash(file.sha256)) return `${where}摘要必须是 64 位十六进制 SHA-256`;
 if (!Number.isInteger(file.chunk_size) || file.chunk_size <= 0) return `${where}分块大小必须是正整数`;
 if (file.chunk_size > file.size) return `${where}分块大小不能大于文件字节数`;
 return null;
}

// 创建证据包的送审输入。
export function validateSubmission(input) {
 if (!input || typeof input !== 'object' || Array.isArray(input)) return '送审内容必须是对象';
 if (!isStr(input.measure_id)) return '措施编号 measure_id 缺失';
 if (!isStr(input.measure)) return '措施内容 measure 缺失';
 const siteErr = validateSite(input.site);
 if (siteErr) return siteErr;
 if (!isStr(input.capture_at) || Number.isNaN(Date.parse(input.capture_at))) return '采集时间缺失或不可解析（需保留原偏移）';
 if (!Array.isArray(input.files) || input.files.length === 0) return '文件清单不能为空';
 for (let i = 0; i < input.files.length; i++) {
  const err = validateFileEntry(input.files[i], i);
  if (err) return err;
 }
 if (input.supersedes !== undefined && input.supersedes !== null && !isStr(input.supersedes)) return '补交关系 supersedes 必须是证据包编号';
 return null;
}

// 规范化序列化：键排序、无多余空白，保证摘要可跨进程复现。
export function canonicalJSON(value) {
 if (value === null || typeof value !== 'object') return JSON.stringify(value);
 if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
 return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

// 证据包版本摘要：覆盖措施、现场记录、检查位置与每个文件的摘要。
export function packageDigest(submission) {
 const basis = {
  measure_id: submission.measure_id,
  measure: submission.measure,
  site: submission.site,
  capture_at: submission.capture_at,
  supersedes: submission.supersedes ?? null,
  files: submission.files.map(f => ({
   name: f.name, path: f.path, size: f.size, sha256: f.sha256,
   media: f.media ?? null, role: f.role ?? null
  }))
 };
 return createHash('sha256').update(canonicalJSON(basis), 'utf8').digest('hex');
}

export const decisions = ['approved', 'rejected', 'returned'];

export function validateReview(body) {
 if (!body || typeof body !== 'object' || Array.isArray(body)) return '复核意见必须是对象';
 if (!isStr(body.reviewer)) return '复核人缺失';
 if (!decisions.includes(body.decision)) return `复核结论必须是 ${decisions.join('/')}`;
 if (!isStr(body.opinion)) return '复核意见正文缺失';
 const siteErr = validateSite(body.check_site);
 if (siteErr) return `复核检查位置无效：${siteErr}`;
 return null;
}
