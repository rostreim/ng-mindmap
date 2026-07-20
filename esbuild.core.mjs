import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/app/mindmap/mindmap-core.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'MindmapCoreBundle',
  outfile: 'demo/mindmap-core.bundle.js',
  target: 'es2020',
});

console.log('Built demo/mindmap-core.bundle.js');
