import {readFile} from 'node:fs/promises';
import {HttpError} from './errors.mjs';
export const fields = ["measure_id", "site", "files", "capture_at"];
export async function readRecords(path) {
 const rows = JSON.parse(await readFile(path, 'utf8'));
 if (!Array.isArray(rows)) throw new TypeError('记录集合必须是数组');
 for (const row of rows) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || fields.some(key => !Object.hasOwn(row, key))) throw new TypeError('记录字段不完整');
 }
 return structuredClone(rows);
}

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const NAME_RE = /^[^/\\\x00-\x1f]{1,200}$/;
const MAX_FILE_SIZE = 64 * 1024 * 1024 * 1024;
const MAX_CHUNK_SIZE = 32 * 1024 * 1024;
const MAX_CHUNKS = 10000;

const bad = (code, message, details) => new HttpError(400, code, message, details);

function needObject(body) {
 if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('BODY_INVALID', '请求体必须是 JSON 对象');
 return body;
}
function needString(obj, key) {
 const v = obj[key];
 if (typeof v !== 'string' || !v.trim()) throw bad('FIELD_INVALID', `字段 ${key} 必须是非空字符串`);
 return v;
}
function needFileName(obj, key = 'name') {
 const v = needString(obj, key);
 if (!NAME_RE.test(v) || v.includes('..')) throw bad('FILE_NAME_INVALID', `文件名 ${key} 不合法：不得包含路径分隔符、控制字符或 ".."`);
 return v;
}
function needDigest(obj, key = 'sha256') {
 const v = obj[key];
 if (typeof v !== 'string' || !SHA256_RE.test(v)) throw bad('DIGEST_INVALID', `字段 ${key} 必须是 64 位小写十六进制 SHA-256`);
 return v;
}
function needInt(obj, key, min, max) {
 const v = obj[key];
 if (!Number.isInteger(v) || v < min || v > max) throw bad('FIELD_INVALID', `字段 ${key} 必须是 ${min}..${max} 的整数`);
 return v;
}

export function validateUploadRequest(body) {
 const b = needObject(body);
 const name = needFileName(b);
 const size = needInt(b, 'size', 1, MAX_FILE_SIZE);
 const chunk_size = needInt(b, 'chunk_size', 1, MAX_CHUNK_SIZE);
 const sha256 = needDigest(b);
 if (Math.ceil(size / chunk_size) > MAX_CHUNKS) throw bad('TOO_MANY_CHUNKS', `分块数量超过上限 ${MAX_CHUNKS}`);
 return {name, size, chunk_size, sha256};
}

export function validateFileEntries(list) {
 if (!Array.isArray(list) || !list.length) throw bad('FILES_INVALID', 'files 必须是非空数组');
 const seen = new Set();
 return list.map(item => {
  const b = needObject(item);
  const name = needFileName(b);
  if (seen.has(name)) throw bad('FILE_NAME_DUPLICATE', `文件名重复: ${name}`);
  seen.add(name);
  return {name, sha256: needDigest(b), size: needInt(b, 'size', 0, MAX_FILE_SIZE)};
 });
}

export function validateSealRequest(body) {
 const b = needObject(body);
 const input = {measure_id: needString(b, 'measure_id'), submitted_by: needString(b, 'submitted_by'), files: validateFileEntries(b.files)};
 if (b.note !== undefined) {
  if (typeof b.note !== 'string' || b.note.length > 500) throw bad('FIELD_INVALID', 'note 必须是不超过 500 字的字符串');
  input.note = b.note;
 }
 for (const key of ['site', 'capture_at']) {
  if (b[key] !== undefined) {
   if (typeof b[key] !== 'string' || !b[key]) throw bad('FIELD_INVALID', `字段 ${key} 必须是非空字符串`);
   input[key] = b[key];
  }
 }
 return input;
}

export function validateReviewRequest(body) {
 const b = needObject(body);
 return {
  package_id: needString(b, 'package_id'),
  version: needInt(b, 'version', 1, 1000000),
  location: needString(b, 'location'),
  conclusion: needString(b, 'conclusion'),
  reviewer: needString(b, 'reviewer'),
 };
}

export function validateWithdrawalRequest(body) {
 const b = needObject(body);
 return {record_ref: needString(b, 'record_ref'), reason: needString(b, 'reason'), operator: needString(b, 'operator')};
}

export function validateGrantRequest(body) {
 const b = needObject(body);
 return {file: needFileName(b, 'file'), ttl_seconds: needInt(b, 'ttl_seconds', 1, 86400)};
}
