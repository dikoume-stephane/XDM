import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

test('T-C-01 : un seul protocole applicatif — HTTP/1.1, jamais HTTP/2', async () => {
  // `EX-C-01` : le binaire d'IDM ne parle qu'HTTP/1.1 (annexe 15 §2.1). On vérifie que
  // XDM ne tire pas `node:http2` : la couche réseau est `node:http`/`node:https`.
  const files = (await readdir(SRC)).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 10);

  const forbidden = [];
  for (const file of files) {
    const source = await readFile(join(SRC, file), 'utf8');
    if (/from ['"]node:http2['"]|require\(['"]node:http2['"]\)/.test(source)) forbidden.push(file);
  }
  assert.deepEqual(forbidden, [], 'aucun module ne charge node:http2');

  const client = await readFile(join(SRC, 'http-client.js'), 'utf8');
  assert.match(client, /import http from 'node:http'/);
  assert.match(client, /import https from 'node:https'/);
  assert.match(client, /HTTP\/1|http\.request|lib\.request/, 'requêtes émises par node:http');
});
