// 构建：esbuild 打包三个入口 + 拷贝静态资源 → dist/
// 用法：node scripts/build.mjs [--watch]
import { build, context } from 'esbuild'
import { copyFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist')
const watch = process.argv.includes('--watch')
// 允许从全局 node_modules 解析（离线环境）；正常安装后走本地 node_modules
const nodePaths = (process.env.AA_NODE_PATHS || '').split(':').filter(Boolean)
const require = createRequire(join(root, 'package.json'))

// Windows 上 fs.cpSync 遇到非 ASCII 路径会让 Node 崩溃，手写递归复制
function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(join(src, e.name), join(dst, e.name))
    else copyFileSync(join(src, e.name), join(dst, e.name))
  }
}

rmSync(out, { recursive: true, force: true })
copyDir(join(root, 'public'), out)

function resolvePkg(p) {
  for (const base of [root, ...nodePaths]) {
    try { return require.resolve(p, { paths: [base] }) } catch {}
  }
  throw new Error('找不到依赖 ' + p + '，请先 npm install')
}
const worker = resolvePkg('pdfjs-dist/build/pdf.worker.min.mjs')
copyFileSync(worker, join(out, 'pdf.worker.min.mjs'))

const common = {
  bundle: true,
  target: 'chrome114',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  nodePaths,
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"', __BUILD_ID__: JSON.stringify(String(Date.now())) },
  // 系统提示词（src/prompts/*.md）按文本打包进扩展
  loader: { '.md': 'text' },
  jsx: 'automatic',
  charset: 'utf8',
}
const entries = [
  { entryPoints: [join(root, 'src/background/index.ts')], outfile: join(out, 'background.js'), format: 'esm' },
  { entryPoints: [join(root, 'src/content/index.ts')], outfile: join(out, 'content.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/sidepanel/main.tsx')], outfile: join(out, 'sidepanel.js'), format: 'esm' },
  { entryPoints: [join(root, 'src/options/main.tsx')], outfile: join(out, 'options.js'), format: 'esm' },
]
if (watch) {
  for (const e of entries) (await context({ ...common, ...e })).watch()
  console.log('watching…')
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })))
  if (!existsSync(join(out, 'manifest.json'))) throw new Error('manifest 缺失')
  console.log('built → dist/')
}
