import {mkdir, writeFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sampleRecords, SAMPLE_FILE_DEFS, fileBytes} from '../sample.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
await mkdir(join(root, 'source-files'), {recursive: true});
for (const def of SAMPLE_FILE_DEFS) {
 await writeFile(join(root, 'source-files', def.name), fileBytes(def.name, def.size));
}
await writeFile(join(root, 'example.json'), JSON.stringify(sampleRecords(), null, 2) + '\n');
console.log('已生成 data/example.json 与 data/source-files/（虚构样例数据）');
