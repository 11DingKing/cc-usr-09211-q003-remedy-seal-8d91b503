import {readFile} from 'node:fs/promises';
export const fields = ["measure_id", "site", "files", "capture_at"];
export async function readRecords(path) {
 const rows = JSON.parse(await readFile(path, 'utf8'));
 if (!Array.isArray(rows)) throw new TypeError('记录集合必须是数组');
 for (const row of rows) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || fields.some(key => !Object.hasOwn(row, key))) throw new TypeError('记录字段不完整');
 }
 return structuredClone(rows);
}
