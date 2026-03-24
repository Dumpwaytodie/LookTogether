const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const OBFUSCATE_OPTIONS = {
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

function obfuscateFile(inputPath, outputPath) {
  const code = fs.readFileSync(inputPath, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, OBFUSCATE_OPTIONS);
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, result.getObfuscatedCode(), 'utf8');
  const ratio = ((1 - code.length / result.getObfuscatedCode().length) * -100).toFixed(0);
  console.log(`✅ ${inputPath} → ${outputPath} (${result.getObfuscatedCode().length} chars)`);
}

console.log('\n🔐 Obfuscating source files...\n');

obfuscateFile(
  path.join(__dirname, '../server/index.js'),
  path.join(__dirname, '../dist/server/index.js')
);

const jsDir = path.join(__dirname, '../public/js');
fs.readdirSync(jsDir)
  .filter(f => f.endsWith('.js'))
  .forEach(file => {
    obfuscateFile(
      path.join(jsDir, file),
      path.join(__dirname, '../dist/public/js', file)
    );
  });

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(src).forEach(file => {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (!file.endsWith('.js')) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`📋 Copied: ${file}`);
    }
  });
}

copyDir(
  path.join(__dirname, '../public'),
  path.join(__dirname, '../dist/public')
);

console.log('\n✨ Build complete! Output: ./dist/\n');
