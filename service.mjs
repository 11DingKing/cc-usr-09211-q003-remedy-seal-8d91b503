import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
export function makeServer() { return createServer((req, res) => {
 const healthy = req.url === '/health';
 res.writeHead(healthy ? 200 : 404, {'Content-Type': 'application/json; charset=utf-8'});
 res.end(JSON.stringify(healthy ? {status: 'ok'} : {error: '接口不存在'}));
}); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) makeServer().listen(Number(process.env.PORT || 8080), '0.0.0.0');
