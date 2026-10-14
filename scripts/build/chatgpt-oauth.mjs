import fs from 'node:fs';
import path from 'node:path';
const output = process.argv[2] ?? 'dist/main';
fs.cpSync('src/main/chatgpt-oauth/lib', path.join(output, 'main/chatgpt-oauth/lib'), { recursive: true });
