import { readFile, writeFile } from 'node:fs/promises';
import { waterloo } from '../dist/waterloo.mjs';
import { mcmaster } from '../dist/mcmaster.mjs';

const dist = new URL('../dist/', import.meta.url);
const read = name => readFile(new URL(name, dist), 'utf8');
const [html, css, editorCss, leafletCss, leafletScript, ...modules] = await Promise.all([
  read('index.html'), read('styles.css'), read('route-editor.css'),
  read('vendor/leaflet/leaflet.css'), read('vendor/leaflet/leaflet.js'),
  ...['engine.mjs', 'outdoor-network.mjs', 'outdoor-anchors.mjs', 'outdoor-routing.mjs',
    'route-editor.mjs', 'real-maps.mjs', 'app.mjs'].map(read),
]);
const leafletImages = await Promise.all(['layers.png', 'layers-2x.png', 'marker-icon.png'].map(async file => {
  const asset = await readFile(new URL(`vendor/leaflet/images/${file}`, dist));
  return [file, `data:image/png;base64,${asset.toString('base64')}`];
}));
let inlinedLeafletCss = leafletCss;
for (const [file, url] of leafletImages) inlinedLeafletCss = inlinedLeafletCss.replaceAll(`images/${file}`, url);
const campusData = Object.entries({ waterloo, mcmaster }).map(([name, campus]) =>
  `const ${name} = ${JSON.stringify(campus).replaceAll('<', '\\u003c')};`);
const bundledModules = [...campusData, ...modules.map(source => source
  .replace(/^import .*?;\n/gm, '')
  .replace(/^export /gm, '')
)].join('\n;\n');
const bundled = html
  .replace('<link rel="stylesheet" href="vendor/leaflet/leaflet.css">', () => `<style>${inlinedLeafletCss}</style>`)
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>${css}</style>`)
  .replace('<link rel="stylesheet" href="route-editor.css">', () => `<style>${editorCss}</style>`)
  .replace('<script src="vendor/leaflet/leaflet.js"></script>', () => `<script>\n${leafletScript.replace(/^\/\/# sourceMappingURL=.*$/gm, '')}\n</script>`)
  .replace('<script type="module" src="app.mjs"></script>', () => `<script>\n${bundledModules}\n</script>`);
await writeFile(new URL('offline.html', dist), bundled);
console.log(`Offline app ready: ${Buffer.byteLength(bundled)} bytes. All route data is bundled.`);
