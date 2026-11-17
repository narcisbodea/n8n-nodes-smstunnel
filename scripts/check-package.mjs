// Checks a packed n8n-nodes-smstunnel tarball before it is published (publish.yml, build job), since pack and publish
// run with --ignore-scripts:
//   node scripts/check-package.mjs <package.tgz> <release tag, such as v1.2.0>
// - it has package.json, README.md, LICENSE, the main file, every file of n8n.nodes and n8n.credentials, the icons
//   those files point to (file:…) and each node's codex file;
// - it has nothing else: only package.json, README.md, LICENSE, the main file and, under dist/, .js, .d.ts, codex
//   .json and .svg/.png files (no tests, no TypeScript sources, no .env, no source maps, no node_modules);
// - its package.json is n8n-nodes-smstunnel, with the tag's version and no runtime dependencies.
// Prints one line per check and exits 1 on any failure. Reads the tar itself (Node's zlib only).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [file, tag] = process.argv.slice(2);
if (!file || !tag) {
	console.error('Usage: node scripts/check-package.mjs <package.tgz> <release tag, such as v1.2.0>');
	process.exit(2);
}

/** The files of a .tgz (ustar, with pax headers for long names), as name → content. */
function readTar(tgz) {
	const tar = zlib.gunzipSync(fs.readFileSync(tgz));
	const files = new Map();
	let longName;
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '');
		const size = parseInt(text(124, 12).trim() || '0', 8);
		const type = text(156, 1);
		const prefix = text(345, 155);
		const name = longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
		const body = tar.subarray(offset + 512, offset + 512 + size);
		longName = undefined;
		if (type === 'x') {
			longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
		} else if (type === 'L') {
			longName = body.toString('utf8').replace(/\0[\s\S]*$/, '');
		} else if (type === '0' || type === '') {
			files.set(name, body);
		} else if (type !== '5' && type !== 'g') {
			files.set(name, body); // a link or anything else: listed, so the allow-list sees it
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return files;
}

const failures = [];
const check = (ok, what) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
	if (!ok) failures.push(what);
};

const files = readTar(file);
const names = [...files.keys()];
console.log(`${path.basename(file)}: ${names.length} files`);
check(names.every((name) => name.startsWith('package/')), 'every file is under package/');

const manifestFile = files.get('package/package.json');
check(manifestFile !== undefined, 'package.json is in the package');
const manifest = manifestFile ? JSON.parse(manifestFile.toString('utf8')) : {};
check(manifest.name === 'n8n-nodes-smstunnel', `the name is n8n-nodes-smstunnel (${manifest.name})`);
check(tag === `v${manifest.version}`, `the release tag ${tag} is v + the package version (${manifest.version})`);
check(Object.keys(manifest.dependencies ?? {}).length === 0, 'no runtime dependencies');

// What must be there.
const declared = [...(manifest.n8n?.nodes ?? []), ...(manifest.n8n?.credentials ?? [])];
check((manifest.n8n?.nodes ?? []).length > 0, 'n8n.nodes lists at least one node');
const required = new Set(['package.json', 'README.md', 'LICENSE', ...(manifest.main ? [manifest.main] : []), ...declared]);
for (const entry of declared) {
	const source = files.get(`package/${entry}`)?.toString('utf8') ?? '';
	for (const [, icon] of source.matchAll(/["']file:([^"']+)["']/g)) required.add(path.posix.join(path.posix.dirname(entry), icon));
	if (entry.endsWith('.node.js')) required.add(entry.replace(/\.js$/, '.json'));
}
for (const entry of [...required].sort()) check(files.has(`package/${path.posix.normalize(entry)}`), `has ${path.posix.normalize(entry)}`);

// What may be there.
const allowed = (name) => {
	const inside = name.slice('package/'.length);
	if (['package.json', 'README.md', 'LICENSE', manifest.main].includes(inside)) return true;
	if (!inside.startsWith('dist/')) return false;
	if (/(^|\/)\.env/i.test(inside) || inside.endsWith('.map') || /(^|\/)(test|tests|__tests__|e2e)\//.test(inside)) return false;
	return /\.(js|d\.ts|node\.json|svg|png)$/.test(inside);
};
const unexpected = names.filter((name) => !allowed(name));
check(unexpected.length === 0, `nothing else (no tests, sources, .env, maps): ${unexpected.length ? unexpected.join(', ') : 'none found'}`);

console.log(failures.length === 0 ? 'The package is ready to publish.' : `${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
