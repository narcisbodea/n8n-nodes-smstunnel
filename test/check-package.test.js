// scripts/check-package.mjs, the check of the packed tarball in publish.yml, on tarballs made here: the real built
// files (npm test builds dist/ first), and copies with a symbolic or hard link, pax and GNU long names, directories.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
let checkPackage;
let readTar;
before(async () => {
	({ checkPackage, readTar } = await import('../scripts/check-package.mjs'));
});

/** One ustar header block. */
function header(name, { type = '0', size = 0, linkname = '' } = {}) {
	const block = Buffer.alloc(512, 0);
	block.write(name.slice(0, 100), 0, 'utf8');
	block.write('0000644\0', 100);
	block.write('0000000\0', 108);
	block.write('0000000\0', 116);
	block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
	block.write('15000000000\0', 136);
	block.write('        ', 148);
	block.write(type, 156);
	block.write(linkname, 157, 'utf8');
	block.write('ustar\0', 257);
	block.write('00', 263);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
	return block;
}
const entry = (name, content = '', options = {}) => {
	const body = Buffer.from(content);
	return Buffer.concat([header(name, { ...options, size: body.length }), body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
};
/** A pax record, "<length> <key>=<value>\n", where the length counts itself. */
const paxRecord = (key, value) => {
	const rest = ` ${key}=${value}\n`;
	let length = rest.length + 1;
	while (String(length).length + rest.length !== length) length = String(length).length + rest.length;
	return `${length}${rest}`;
};
const tgz = (...parts) => zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));

/** The package as npm packs it: package.json, README.md, LICENSE, index.js and dist/. */
function realEntries({ skip = [] } = {}) {
	const files = ['package.json', 'README.md', 'LICENSE', 'index.js'];
	const walk = (dir) => {
		for (const name of fs.readdirSync(path.join(ROOT, dir))) {
			const relative = `${dir}/${name}`;
			if (fs.statSync(path.join(ROOT, relative)).isDirectory()) walk(relative);
			else files.push(relative);
		}
	};
	walk('dist');
	return files.filter((f) => !skip.includes(f)).map((f) => entry(`package/${f}`, fs.readFileSync(path.join(ROOT, f))));
}
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TAG = `v${version}`;
const ICON = 'dist/nodes/SmsTunnel/smstunnel.svg';

describe('scripts/check-package.mjs', () => {
	it('passes the package as built', () => {
		const { ok, lines } = checkPackage(tgz(...realEntries()), TAG);
		assert.ok(ok, lines.join('\n'));
		assert.ok(lines.includes('ok   only regular files and directories: yes'));
	});

	it('fails a symbolic link, even one with an allowed name, and names it', () => {
		const tarball = tgz(...realEntries({ skip: [ICON] }), entry(`package/${ICON}`, '', { type: '2', linkname: '/etc/passwd' }));
		const { ok, failures } = checkPackage(tarball, TAG);
		assert.equal(ok, false);
		assert.ok(failures.includes(`only regular files and directories: package/${ICON} (symbolic link → /etc/passwd)`), failures.join('\n'));
		// Not counted as the icon either.
		assert.ok(failures.includes(`has ${ICON}`));
	});

	it('fails a hard link, a GNU long name and any other kind of entry', () => {
		for (const [type, kind] of [['1', 'hard link'], ['L', 'GNU long name'], ['3', 'character device'], ['6', 'FIFO']]) {
			const tarball = tgz(...realEntries(), entry('package/dist/extra.js', type === 'L' ? 'package/dist/x.js' : '', { type, linkname: type === '1' ? 'package/package.json' : '' }));
			const { ok, failures } = checkPackage(tarball, TAG);
			assert.equal(ok, false, kind);
			assert.match(failures[0], new RegExp(`^only regular files and directories: package/dist/extra\\.js \\(${kind}`), kind);
		}
	});

	it('reads a pax header for the name of the next entry, and never lists the header itself', () => {
		const long = `package/dist/nodes/SmsTunnel/${'a'.repeat(120)}.js`;
		const tarball = tgz(...realEntries(), entry('PaxHeader/long', paxRecord('path', long), { type: 'x' }), entry('package/dist/short.js', '// long'), entry('pax_global_header', paxRecord('comment', 'x'), { type: 'g' }));
		const names = readTar(tarball).map((e) => e.name);
		assert.ok(names.includes(long));
		assert.ok(!names.some((n) => n.includes('PaxHeader') || n.includes('pax_global_header') || n === 'package/dist/short.js'));
		assert.ok(checkPackage(tarball, TAG).ok);

		// A pax linkpath on a link is shown as its target.
		const linked = tgz(...realEntries({ skip: [ICON] }), entry('PaxHeader/link', paxRecord('linkpath', '/root/.ssh/id_rsa'), { type: 'x' }), entry(`package/${ICON}`, '', { type: '2', linkname: 'short' }));
		assert.ok(checkPackage(linked, TAG).failures.some((f) => f.includes('(symbolic link → /root/.ssh/id_rsa)')));
	});

	it('takes directory entries, without counting them as files', () => {
		const tarball = tgz(entry('package/', '', { type: '5' }), entry('package/dist/', '', { type: '5' }), ...realEntries());
		const { ok, lines } = checkPackage(tarball, TAG);
		assert.ok(ok, lines.join('\n'));
	});
});
