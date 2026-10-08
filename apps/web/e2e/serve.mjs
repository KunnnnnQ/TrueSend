/**
 * Serves the static export the way GitHub Pages serves a project site, for the browser tests.
 *
 *   node e2e/serve.mjs <out dir> <port> [/BasePath]
 *
 * Under /<repository>/, a directory answers with its index.html, a directory without a trailing
 * slash redirects to one, `x` falls back to `x.html`, and anything missing gets 404.html with status
 * 404. Testing behind `next start` instead would test a server the live demo does not have.
 */

import {createServer} from "node:http";
import {createReadStream, existsSync, statSync} from "node:fs";
import {extname, join, normalize, resolve} from "node:path";

const root = resolve(process.argv[2] ?? "out");
const port = Number(process.argv[3] ?? 4173);
const base = process.argv[4] ?? "/TrueSend";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

if (!existsSync(join(root, "index.html"))) {
  console.error(`${root} has no index.html. Build it first: PAGES_BASE_PATH=${base} next build`);
  process.exit(1);
}

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname);
  if (path === "/" || path === base) return redirect(response, `${base}/`);
  if (!path.startsWith(`${base}/`)) return notFound(response);

  const relative = path.slice(base.length);
  let file = join(root, normalize(relative));
  if (!file.startsWith(root)) return notFound(response);

  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!relative.endsWith("/")) return redirect(response, `${path}/`);
    file = join(file, "index.html");
  } else if (!existsSync(file) && existsSync(`${file}.html`)) {
    file = `${file}.html`;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) return notFound(response);

  response.writeHead(200, {"content-type": TYPES[extname(file)] ?? "application/octet-stream"});
  createReadStream(file).pipe(response);
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} at http://127.0.0.1:${port}${base}/`));

function redirect(response, location) {
  response.writeHead(301, {location});
  response.end();
}

function notFound(response) {
  const page = join(root, "404.html");
  response.writeHead(404, {"content-type": "text/html; charset=utf-8"});
  if (existsSync(page)) createReadStream(page).pipe(response);
  else response.end("not found");
}
