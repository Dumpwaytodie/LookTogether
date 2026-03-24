const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const OPTS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  selfDefending: false,
};

function obfuscate(src, dest) {
  const code = fs.readFileSync(src, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, OPTS);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, result.getObfuscatedCode());
  console.log(`✅ ${path.relative(process.cwd(), src)} → ${path.relative(process.cwd(), dest)}`);
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dest, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else if (!f.endsWith('.js')) { fs.copyFileSync(s, d); console.log(`📋 ${f}`); }
  }
}

console.log('\n🔐 Building & obfuscating...\n');

obfuscate('server/index.js', 'dist/server/index.js');

const jsDir = 'public/js';
for (const f of fs.readdirSync(jsDir).filter(f => f.endsWith('.js')))
  obfuscate(path.join(jsDir, f), path.join('dist/public/js', f));

copyDir('public', 'dist/public');

console.log('\n✨ Done! Output → dist/\n');
