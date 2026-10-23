// Run from the repo: nix shell nixpkgs#python3Packages.fonttools --command node apps/client/scripts/subset-icons.mjs
// Android uses the original native font. Add names here when adding web icon controls.
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const source = new URL(
  '../../../node_modules/@react-native-vector-icons/material-design-icons/',
  import.meta.url,
)
const assets = new URL('../src/assets/', import.meta.url)
const names = [
  'alert-circle',
  'alert-circle-outline',
  'arrow-left',
  'arrow-right',
  'check',
  'check-circle',
  'check-circle-outline',
  'chevron-down',
  'chevron-left',
  'chevron-right',
  'chevron-up',
  'close',
  'close-circle',
  'close-circle-outline',
  'content-copy',
  'delete-outline',
  'dots-horizontal',
  'dots-vertical',
  'download',
  'eye',
  'eye-off',
  'help-circle-outline',
  'information',
  'information-outline',
  'magnify',
  'menu',
  'menu-down',
  'menu-up',
  'pause',
  'play',
  'refresh',
  'upload',
]
const all = JSON.parse(readFileSync(new URL('glyphmaps/MaterialDesignIcons.json', source)))
const glyphs = Object.fromEntries(
  names.map((name) => {
    if (!Number.isInteger(all[name])) throw Error(`Unknown Material icon: ${name}`)
    return [name, all[name]]
  }),
)
execFileSync(
  'pyftsubset',
  [
    new URL('fonts/MaterialDesignIcons.ttf', source).pathname,
    `--output-file=${new URL('material-icons.woff', assets).pathname}`,
    '--flavor=woff',
    `--unicodes=${Object.values(glyphs)
      .map((code) => code.toString(16))
      .join(',')}`,
    '--no-recalc-timestamp',
    '--no-ignore-missing-unicodes',
  ],
  { stdio: 'inherit' },
)
writeFileSync(new URL('material-icons.json', assets), `${JSON.stringify(glyphs, null, 2)}\n`)
writeFileSync(new URL('material-icons.LICENSE', assets), readFileSync(new URL('LICENSE', source)))
console.log(
  `${names.length} glyphs, ${statSync(new URL('material-icons.woff', assets)).size} bytes`,
)
