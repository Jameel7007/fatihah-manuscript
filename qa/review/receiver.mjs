// One-shot capture sink for review screenshots: the capture page POSTs its PNG here.
// Run: node qa/review/receiver.mjs — writes qa/review/<name>.png. Dev utility only.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.end();
    return;
  }
  const name = (new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? 'frame').replace(/[^\w.-]/g, '_');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const file = join(dir, `${name}.png`);
    writeFileSync(file, Buffer.concat(chunks));
    console.log(`saved ${file} (${Buffer.concat(chunks).length} bytes)`);
    res.end('ok');
  });
}).listen(4599, () => console.log('capture sink on :4599'));
