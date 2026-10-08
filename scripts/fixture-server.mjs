import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const fixtureBytes = Buffer.from('Upload Session local attachment proof.\n');

export function startFixture(port = 0) {
  let submissions = 0;
  let downloads = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/sample.txt' }); return res.end(); }
    if (req.url === '/large') { res.writeHead(200, { 'Content-Length': String(21 * 1024 * 1024) }); return res.end(); }
    if (req.url === '/sample.txt') {
      downloads++;
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="sample.txt"' });
      return res.end(fixtureBytes);
    }
    if (req.url === '/submit') {
      submissions++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(Buffer.concat(chunks));
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Upload Session test form</title>
      <h1>Local upload test</h1><p><a href="/sample.txt">Download sample.txt</a></p>
      <form action="/submit" method="post" enctype="multipart/form-data">
        <label>Document <input id="document" type="file" name="document" accept=".txt,text/plain"></label>
        <button type="submit">Submit myself</button>
      </form>
      <h2>Manual fallback checks</h2>
      <p><a href="http://localhost:${server.address().port}/sample.txt">Download sample.txt from another origin (permission prompt test)</a></p>
      <ul><li><a href="/redirect">Redirected download (unsupported)</a></li>
      <li><a href="/large">Oversized download (unsupported)</a></li>
      <li><a href="/">HTML page instead of a file (unsupported)</a></li></ul></html>`);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    server, url: `http://127.0.0.1:${server.address().port}`, submissions: () => submissions, downloads: () => downloads,
  })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startFixture(8787);
  console.log(`Local test form: ${fixture.url}`);
}
