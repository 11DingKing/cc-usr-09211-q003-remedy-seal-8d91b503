// 崩溃演练：在证据包目录 rename 完成、登记日志写入之前直接退出进程。
// 用法: node crash-seal.mjs <storeDir> <inputJson>
import {Store} from '../../store.mjs';

const [storeDir, inputJson] = process.argv.slice(2);
const store = new Store(storeDir, {hooks: {afterRename: () => process.exit(0)}});
await store.seal(JSON.parse(inputJson));
console.error('应当已在 afterRename 钩子中退出');
process.exit(1);
