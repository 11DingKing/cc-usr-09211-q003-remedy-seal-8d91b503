// 种子数据：生成虚构的整改措施样例与确定性原件。
// 所有编号、地点、人员均为虚构；不使用随机数，重复执行得到相同摘要。
import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SEED_DATA_DIR || join(here, '..', 'data');
const rawDir = join(dataDir, 'raw');

function sha256(buf) {
 return createHash('sha256').update(buf).digest('hex');
}

// 确定性内容生成：同一条记录的同一文件每次生成字节完全一致。
function makeFile(rec, index) {
 const head = `【虚构样例】${rec.measure_id} / ${rec.files[index].name}\n`;
 const filler = `乡道整改示范工程资料（虚构编号 ${rec.measure_id}）。`.repeat(48 + index * 16);
 return Buffer.from(head + filler + `\n采集位置：${rec.site.name}\n采集时间：${rec.capture_at}\n`, 'utf8');
}

export const seedRecords = [
 {
  measure_id: 'MS-2026-0007',
  measure: 'K12+300 段排水沟清淤与盖板修复',
  site: {name: '青山乡·云岭村三组路口', code: 'QS-YL-03', longitude: 118.1234, latitude: 30.5678},
  capture_at: '2026-09-12T09:30:00+08:00',
  files: [
   {name: '现场全景照.jpg', media: 'image/jpeg', role: 'site_photo'},
   {name: '清淤前后对比.jpg', media: 'image/jpeg', role: 'site_photo'},
   {name: '排水沟断面丈量记录.txt', media: 'text/plain', role: 'field_note'}
  ]
 },
 {
  measure_id: 'MS-2026-0008',
  measure: '村道 C021 照明灯具更换（12 盏）',
  site: {name: '青山乡·石桥镇沿河步道', code: 'QS-SQ-07', longitude: 118.1241, latitude: 30.5690},
  capture_at: '2026-09-14T16:10:00+08:00',
  files: [
   {name: '灯具安装点位照.jpg', media: 'image/jpeg', role: 'site_photo'},
   {name: '通电试亮记录.txt', media: 'text/plain', role: 'field_note'},
   {name: '灯具合格证摘要.txt', media: 'text/plain', role: 'doc_summary'}
  ]
 },
 {
  measure_id: 'MS-2026-0009',
  measure: '候车亭基础混凝土浇筑与警示标识补设',
  site: {name: '青山乡·大田村候车点', code: 'QS-DT-02', longitude: 118.1302, latitude: 30.5721},
  capture_at: '2026-09-18T10:05:00+08:00',
  files: [
   {name: '基础钢筋绑扎照.jpg', media: 'image/jpeg', role: 'site_photo'},
   {name: '浇筑完成照.jpg', media: 'image/jpeg', role: 'site_photo'},
   {name: '警示标志清点单.txt', media: 'text/plain', role: 'doc_summary'}
  ]
 }
];

export async function seed(dataDirArg = dataDir) {
 const raw = join(dataDirArg, 'raw');
 await mkdir(raw, {recursive: true});
 const records = [];
 for (const rec of seedRecords) {
  const files = [];
  for (let i = 0; i < rec.files.length; i++) {
   const buf = makeFile(rec, i);
   const rel = `${rec.measure_id}/${rec.files[i].name}`;
   await mkdir(join(raw, rec.measure_id), {recursive: true});
   await writeFile(join(raw, rel), buf);
   files.push({...rec.files[i], path: rel, size: buf.length, sha256: sha256(buf)});
  }
  records.push({
   measure_id: rec.measure_id,
   measure: rec.measure,
   site: rec.site,
   capture_at: rec.capture_at,
   files
  });
 }
 await writeFile(join(dataDirArg, 'example.json'), JSON.stringify(records, null, 1) + '\n', 'utf8');
 return records;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
 const records = await seed();
 console.log(`已生成 ${records.length} 条虚构样例，原件 ${records.reduce((n, r) => n + r.files.length, 0)} 个：${dataDir}`);
}
