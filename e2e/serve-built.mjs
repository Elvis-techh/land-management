// Serves a BUILT copy of the frontend the way nginx serves it on the droplet,
// for the browser tests (see playwright.config.ts):
//
//   - the files of the build, with `index.html` for any path that is not a file
//     (nginx's `try_files $uri $uri/ /index.html`);
//   - the browser security headers, read from deploy/nginx-headers.conf, on
//     every page and file — the very text the droplet sends, so the tests meet
//     the real Content-Security-Policy and not a copy of it;
//   - `/api/` forwarded to the test backend with NO extra headers, as in
//     docs/nginx.conf.example: the document viewer frames those files, and the
//     headers forbid being framed.
//
// The Vite dev server cannot stand in for this: it adds inline scripts and a
// websocket of its own, so a policy that is right for the real site fails there
// and one that passes there proves nothing about the build people receive.
//
//   node e2e/serve-built.mjs <build folder> <port> <backend port>

import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const [folderArgument, portArgument, apiPortArgument] = process.argv.slice(2);

if (!folderArgument || !portArgument || !apiPortArgument) {
  console.error("Usage: node e2e/serve-built.mjs <build folder> <port> <backend port>");
  process.exit(1);
}

const root = resolve(folderArgument);
const port = Number(portArgument);
const apiPort = Number(apiPortArgument);

// `add_header Name "value" always;` lines, the same shape backend/test/
// nginx-headers.test.ts reads them in.
const snippet = readFileSync(join(import.meta.dirname, "..", "deploy", "nginx-headers.conf"), "utf8");
const securityHeaders = [...snippet.matchAll(/^add_header ([\w-]+) "([^"]*)" always;$/gm)].map(([, name, value]) => [
  name,
  value,
]);

if (securityHeaders.length === 0) {
  console.error("No add_header lines found in deploy/nginx-headers.conf");
  process.exit(1);
}

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function fileFor(urlPath) {
  let decoded;

  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // A stray "%" in the address: not a file, so the app's own page answers.
    return join(root, "index.html");
  }

  const candidate = normalize(join(root, decoded));
  const inside = candidate === root || candidate.startsWith(root + sep);

  if (inside && statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
    return candidate;
  }

  return join(root, "index.html");
}

function forwardToBackend(incoming, outgoing) {
  const upstream = request(
    {
      host: "127.0.0.1",
      port: apiPort,
      method: incoming.method,
      path: incoming.url,
      // Like Vite's `changeOrigin` and nginx's proxy: the backend sees its own
      // host, and the browser's Origin and cookies go through untouched.
      headers: { ...incoming.headers, host: `127.0.0.1:${apiPort}` },
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );

  upstream.on("error", () => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502);
    }
    outgoing.end();
  });
  // The live stream (/api/events) ends when the browser leaves.
  outgoing.on("close", () => upstream.destroy());
  incoming.pipe(upstream);
}

const server = createServer((incoming, outgoing) => {
  const { pathname } = new URL(incoming.url ?? "/", "http://localhost");

  if (pathname.startsWith("/api/")) {
    forwardToBackend(incoming, outgoing);
    return;
  }

  const file = fileFor(pathname);
  const headers = {
    "Content-Type": types[extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  };

  for (const [name, value] of securityHeaders) {
    headers[name] = value;
  }

  outgoing.writeHead(200, headers);
  if (incoming.method === "HEAD") {
    outgoing.end();
    return;
  }
  createReadStream(file).pipe(outgoing);
});

server.listen(port, () => {
  console.log(`Serving ${root} on port ${port} with ${securityHeaders.map(([name]) => name).join(", ")}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
