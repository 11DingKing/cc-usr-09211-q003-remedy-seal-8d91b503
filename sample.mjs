import {createHash} from 'node:crypto';

// 确定性的虚构样例字节：同一文件名与长度永远生成相同内容，便于演示与测试复现。
export function fileBytes(name, size) {
 let x = 2166136261;
 for (const c of Buffer.from(name, 'utf8')) { x ^= c; x = Math.imul(x, 16777619); }
 x >>>= 0;
 if (!x) x = 1;
 const buf = Buffer.alloc(size);
 for (let i = 0; i < size; i++) {
  x ^= x << 13; x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5; x >>>= 0;
  buf[i] = x & 0xff;
 }
 return buf;
}

export const SAMPLE_FILE_DEFS = [
 {name: '整改前-路面破损.jpg', size: 150000},
 {name: '整改后-路面恢复.jpg', size: 160000},
 {name: '施工记录摘要.pdf', size: 80000},
 {name: '补交-材料合格证.pdf', size: 120000},
];

export function sampleFileEntry(def) {
 return {name: def.name, size: def.size, sha256: createHash('sha256').update(fileBytes(def.name, def.size)).digest('hex')};
}

// 虚构业务样例：措施、现场记录、文件摘要的关联。
export function sampleRecords() {
 return [
  {
   measure_id: 'ZL-2026-014',
   site: '青川县凉水镇便民服务中心东侧道路（虚构样例）',
   capture_at: '2026-08-30T09:42:11+08:00',
   files: [0, 1, 2].map(i => sampleFileEntry(SAMPLE_FILE_DEFS[i])),
  },
  {
   measure_id: 'ZL-2026-015',
   site: '青川县凉水镇滨河步道三段（虚构样例）',
   capture_at: '2026-09-02T15:05:47+08:00',
   files: [1, 2].map(i => sampleFileEntry(SAMPLE_FILE_DEFS[i])),
  },
 ];
}
