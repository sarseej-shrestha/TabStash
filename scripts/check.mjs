import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

for (const directory of ['extension', 'scripts', 'tests']) {
  for (const file of await readdir(directory)) {
    if (!/\.m?js$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, 'Upload Session');
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.content_scripts, undefined);
assert.equal(manifest.externally_connectable, undefined);
assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'contextMenus', 'scripting', 'sidePanel', 'storage']);
assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
assert.equal(manifest.background.type, 'module');
for (const file of [manifest.background.service_worker, manifest.side_panel.default_path]) await readFile(`extension/${file}`);
const appScripts = (await readdir('extension')).filter(file => file.endsWith('.js'));
for (const file of appScripts) {
  const source = await readFile(`extension/${file}`, 'utf8');
  assert.doesNotMatch(source, /\.submit\s*\(|\.requestSubmit\s*\(|dispatchEvent\s*\(|eval\s*\(|innerHTML\s*=/, file);
}
console.log('PASS: JavaScript syntax, MV3 manifest, least-privilege declarations, no HTML injection or automatic form submission.');
