// Tiny static server for the web auth page (dev). Node only, no deps.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 5500;
http.createServer((req, res) => {
  const file = path.join(__dirname, "index.html"); // single-page
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); res.end("error"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`web-auth on http://localhost:${PORT}`));
