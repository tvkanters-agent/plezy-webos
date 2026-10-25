// Local test server. Deliberately bound to loopback; never proxies credentials.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('dist');
createServer(async(req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const target=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!target.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  try{const content=await readFile(target);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.mp4':'video/mp4'})[path.extname(target)]||'application/octet-stream');res.end(content);}
  catch(_){res.writeHead(404).end();}
}).listen(8181,'127.0.0.1');
