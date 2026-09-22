// 整改证据封存服务 HTTP 接口。
// 仅依赖 Node 内置模块；未知接口返回 404。
import {createServer} from 'node:http';
import {promises as fs, createReadStream} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {Store, StoreError} from './store.mjs';
import {mkdirp} from './fsutil.mjs';

const json = (res, status, body) => {
 res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
 res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
 const chunks = [];
 let size = 0;
 req.on('data', c => {
  size += c.length;
  if (size > 2 * 1024 * 1024 * 1024) reject(new StoreError(413, 'body_too_large'));
  chunks.push(c);
 });
 req.on('end', () => resolve(Buffer.concat(chunks)));
 req.on('error', reject);
});

const readJSON = async req => {
 const buf = await readBody(req);
 try { return JSON.parse(buf.toString('utf8') || 'null'); }
 catch { throw new StoreError(400, 'bad_json', '请求体不是合法 JSON'); }
};

export function makeServer(store) {
 const fail = (res, err) => {
  if (err instanceof StoreError) return json(res, err.status, {error: err.code, detail: err.detail ?? err.message});
  return json(res, 500, {error: 'internal_error', detail: String(err?.message ?? err)});
 };

 const router = createServer(async (req, res) => {
  try {
   const url = new URL(req.url, 'http://localhost');
   const path = url.pathname;
   const method = req.method;
   if (method === 'GET' && path === '/health') return json(res, 200, {status: 'ok'});

   // 送审建包
   if (method === 'POST' && path === '/packages') {
    const input = await readJSON(req);
    const out = await store.createPackage(input);
    return json(res, 201, out);
   }

   let m;
   if ((m = path.match(/^\/packages\/([^/]+)$/))) {
    const pkg = m[1];
    if (method === 'GET') return json(res, 200, await store.getStatus(pkg));
   }

   // 分块上传（原始字节）：乱序由序号定位，重复/损坏在存储层判定
   if ((m = path.match(/^\/packages\/([^/]+)\/files\/(\d+)\/chunks\/(\d+)$/)) && method === 'PUT') {
    const [, pkg, fi, ci] = m;
    const bytes = await readBody(req);
    return json(res, 200, await store.putChunk(pkg, Number(fi), Number(ci), bytes));
   }

   // 损坏/冲突分块重置，便于按明确结果重新上传
   if ((m = path.match(/^\/packages\/([^/]+)\/files\/(\d+)\/chunks\/(\d+)$/)) && method === 'DELETE') {
    const [, pkg, fi, ci] = m;
    return json(res, 200, await store.resetChunk(pkg, Number(fi), Number(ci)));
   }

   if ((m = path.match(/^\/packages\/([^/]+)\/files\/(\d+)\/assemble$/)) && method === 'POST') {
    return json(res, 200, await store.assembleFile(m[1], Number(m[2])));
   }
   if ((m = path.match(/^\/packages\/([^/]+)\/seal$/)) && method === 'POST') {
    return json(res, 200, await store.seal(m[1]));
   }
   if ((m = path.match(/^\/packages\/([^/]+)\/verify$/)) && method === 'GET') {
    return json(res, 200, await store.verify(m[1]));
   }
   if ((m = path.match(/^\/packages\/([^/]+)\/manifest$/)) && method === 'GET') {
    const {manifest} = await store.readSealedManifest(m[1]);
    return json(res, 200, manifest);
   }
   if ((m = path.match(/^\/packages\/([^/]+)\/withdrawals$/)) && method === 'POST') {
    return json(res, 201, await store.withdraw(m[1], await readJSON(req)));
   }
   if ((m = path.match(/^\/packages\/([^/]+)\/reviews$/)) && method === 'POST') {
    return json(res, 201, await store.review(m[1], await readJSON(req)));
   }
   if ((m = path.match(/^\/packages\/([^/]+)\/tickets$/)) && method === 'POST') {
    const body = await readJSON(req).catch(() => null);
    const ttl = body && Number.isInteger(body.ttl_seconds) ? body.ttl_seconds : 300;
    return json(res, 201, await store.issueTicket(m[1], ttl));
   }

   // 授权下载：核销即一次性使用，核销前整包完整性校验，原件流式输出
   if ((m = path.match(/^\/download\/([^/]+)$/)) && method === 'GET') {
    const pkg = m[1];
    const token = url.searchParams.get('token');
    const fileId = url.searchParams.get('file');
    const report = await store.redeem(token);
    if (report.pkg !== pkg) throw new StoreError(401, 'ticket_scope_mismatch', '票据与证据包不符');
    const target = report.files.find(f => f.id === fileId);
    if (!target) throw new StoreError(404, 'file_not_in_package', '需用 file 指定包内文件编号，可用编号见 files');
    res.writeHead(200, {
     'Content-Type': 'application/octet-stream',
     'Content-Length': target.size,
     'X-Package-Digest': report.digest,
     'X-File-Sha256': target.expected
    });
    return createReadStream(join(store.sealedDir(pkg), 'files', `${target.id}.blob`)).pipe(res);
   }

   res.writeHead(404, {'Content-Type': 'application/json; charset=utf-8'});
   res.end(JSON.stringify({error: '接口不存在'}));
  } catch (err) {
   if (!res.headersSent) return fail(res, err);
   res.destroy();
  }
 });

 return router;
}

export async function start(port = Number(process.env.PORT || 8080), dataRoot = process.env.SEAL_ROOT || './.seal-data') {
 await mkdirp(dataRoot);
 const store = await Store.open(dataRoot);
 const server = makeServer(store);
 await new Promise(resolve => server.listen(port, '0.0.0.0', resolve));
 return {server, store};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const {server} = await start();
 const addr = server.address();
 console.log(`整改证据封存服务已监听 0.0.0.0:${addr.port}`);
}
