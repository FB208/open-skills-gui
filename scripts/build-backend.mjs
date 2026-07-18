import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const entryPoint = path.join(projectRoot, 'src', 'backend', 'index.ts');
const outputFile = path.join(projectRoot, 'extensions', 'backend.cjs');

/** 将 Node 扩展打包为发布目录中的单个 CommonJS 文件。 */
async function buildBackend() {
  await mkdir(path.dirname(outputFile), { recursive: true });
  await build({
    entryPoints: [entryPoint],
    outfile: outputFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  });
}

await buildBackend();
