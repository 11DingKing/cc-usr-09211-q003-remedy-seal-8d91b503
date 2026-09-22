import {mkdir} from 'node:fs/promises';
export async function mkdirp(path) {
 await mkdir(path, {recursive: true});
}
