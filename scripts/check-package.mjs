// Checks a packed n8n-nodes-smstunnel tarball before it is published (publish.yml, build job), since pack and publish
// run with --ignore-scripts:
//   node scripts/check-package.mjs <package.tgz> <release tag, such as v1.2.0>
// - every entry is a regular file or a directory: a link (symbolic or hard) or any other kind fails, by name;
// - it has package.json, README.md, LICENSE, the main file, every file of n8n.nodes and n8n.credentials, the icons
//   those files point to (file:…) and each node's codex file;
// - it has nothing else: only package.json, README.md, LICENSE, the main file and, under dist/, .js, .d.ts, codex
//   .json and .svg/.png files (no tests, no TypeScript sources, no .env, no source maps, no node_modules);
// - its package.json is n8n-nodes-smstunnel, with the tag's version and no runtime dependencies.
// Prints one line per check and exits 1 on any failure. Reads the tar itself (Node's zlib only).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

/** Tar type flags: a regular file is '0' (or NUL in old tars), a directory '5'; pax headers 'x' (next entry), 'g'. */
const REGULAR = new Set(['0', '']);
const DIRECTORY = '5';
const TYPE_NAMES = { 1: 'hard link', 2: 'symbolic link', 3: 'character device', 4: 'block device', 6: 'FIFO', 7: 'contiguous file', L: 'GNU long name', K: 'GNU long link name' };

/**
 * Every entry of a .tgz as { name, type, linkname, size, content }, in order. Pax headers ('x' for the next entry,
 * 'g' global) are read for their path and linkpath and never listed themselves.
 */
export function readTar(tgz) {
	const tar = zlib.gunzipSync(tgz);
	const entries = [];
	let pax = {};
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '');
		const size = parseInt(text(124, 12).trim() || '0', 8);
		const type = text(156, 1);
		const prefix = text(345, 155);
		const content = tar.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;
		if (type === 'x' || type === 'g') {
			// "<length> <key>=<value>\n" records: only path and linkpath matter here.
			const records = {};
			for (const [, key, value] of content.toString('utf8').matchAll(/\d+ ([^=\n]+)=([^\n]*)\n/g)) records[key] = value;
			if (type === 'x') pax = records;
			continue;
		}
		entries.push({
			name: pax.path ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100)),
			type,
			linkname: pax.linkpath ?? text(157, 100),
			size,
			content,
		});
		pax = {};
	}
	return entries;
}

/** The checks, as printed lines; `ok` when none failed. */
export function checkPackage(tgz, tag) {
	const lines = [];
	const failures = [];
	const check = (ok, what) => {
		lines.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
		if (!ok) failures.push(what);
	};

	const entries = readTar(tgz);
	const odd = entries.filter((entry) => !REGULAR.has(entry.type) && entry.type !== DIRECTORY);
	check(
		odd.length === 0,
		`only regular files and directories: ${
			odd.length
				? odd.map((e) => `${e.name} (${TYPE_NAMES[e.type] ?? `type ${JSON.stringify(e.type)}`}${e.linkname ? ` → ${e.linkname}` : ''})`).join(', ')
				: 'yes'
		}`,
	);
	const files = new Map(entries.filter((entry) => REGULAR.has(entry.type)).map((entry) => [entry.name, entry.content]));
	const names = [...files.keys()];
	lines.unshift(`${names.length} files`);
	check(entries.every((entry) => entry.name.startsWith('package/')), 'every entry is under package/');

	const manifestFile = files.get('package/package.json');
	check(manifestFile !== undefined, 'package.json is in the package');
	let manifest = {};
	try {
		manifest = manifestFile ? JSON.parse(manifestFile.toString('utf8')) : {};
	} catch {
		check(false, 'package.json is valid JSON');
	}
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
	for (const entry of [...required].map((e) => path.posix.normalize(e)).sort()) check(files.has(`package/${entry}`), `has ${entry}`);

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

	lines.push(failures.length === 0 ? 'The package is ready to publish.' : `${failures.length} check(s) failed.`);
	return { ok: failures.length === 0, lines, failures };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const [file, tag] = process.argv.slice(2);
	if (!file || !tag) {
		console.error('Usage: node scripts/check-package.mjs <package.tgz> <release tag, such as v1.2.0>');
		process.exit(2);
	}
	const { ok, lines } = checkPackage(fs.readFileSync(file), tag);
	console.log(`${path.basename(file)}: ${lines.join('\n')}`);
	process.exit(ok ? 0 : 1);
}
