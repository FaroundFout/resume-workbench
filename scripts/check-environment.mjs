import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { detectCompiler } from '../server/compiler/environment.mjs';

try {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const config = await loadConfig(project);
  // Child processes inherit the same portable runtime PATH as start.cmd.
  process.env.PATH = dirname(process.execPath) + ';' + (process.env.PATH || '');
  const compiler = await detectCompiler(config);
  console.log('Node and editor are ready.');
  if (compiler.available) console.log('XeLaTeX found; first PDF compilation will verify packages.');
  else {
    console.log(compiler.message);
    console.log('PDF generation still needs MiKTeX/TeX Live and template packages.');
    console.log('MiKTeX: https://miktex.org/download');
  }
  console.log('Environment guide: docs/local-editor.md');
} catch (error) {
  console.error(`Environment check failed (${error.code || 'DETECTION_ERROR'}): ${error.message}`);
  process.exitCode = 1;
}
