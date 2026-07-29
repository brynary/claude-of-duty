#!/usr/bin/env node
/**
 * Regenerates the assets the game is shared and bookmarked with.
 *
 *   node tools/brand-assets.mjs
 *
 * Writes, all into `public/`:
 *   social-card.jpg     1200x630 link preview, composed over a captured frame
 *   favicon-32.png      raster fallback for browsers without SVG icons
 *   apple-touch-icon.png  180x180 home-screen icon
 *
 * The card is laid out in HTML and photographed in the same headless Chrome the
 * screenshot harness uses, so its type is set by the same engine that will
 * render the game — no image editor, and the layout stays editable as text.
 *
 * The backdrop is `public/loading-frame.jpg`, the frame the loading screen
 * already uses: one picture for the game's whole first impression. Replace that
 * file with a fresh capture (`node tools/screenshot.mjs --poses sunset --hud 0`)
 * and re-run this to update both at once.
 */
import { launch } from 'puppeteer-core'
import { readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const ROOT = resolve(process.cwd())
const PUBLIC = join(ROOT, 'public')

const TITLE_TOP = 'Claude'
const TITLE_BOTTOM = 'of Duty'
const EYEBROW = 'Classified // Task Force 141'
const PITCH = 'A first-person shooter that builds its own world in the browser. Every texture, building and soldier is generated at load.'
const URL_LINE = 'brynary.github.io/claude-of-duty'
const CHIPS = ['Procedural world', 'Real-time GI', 'WebGL 2']

/** Finds the newest Chrome that puppeteer has already downloaded. */
function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome')
  if (!existsSync(base)) throw new Error('No cached Chrome. Set CHROME_PATH.')
  const builds = readdirSync(base).sort((a, b) =>
    Number(b.split('-')[1]?.split('.')[0] ?? 0) - Number(a.split('-')[1]?.split('.')[0] ?? 0))
  for (const b of builds) {
    for (const c of [
      join(base, b, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(base, b, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(base, b, 'chrome-linux64', 'chrome'),
    ]) if (existsSync(c)) return c
  }
  throw new Error(`No Chrome executable under ${base}`)
}

const dataUri = (file, mime) => `data:${mime};base64,${readFileSync(join(PUBLIC, file)).toString('base64')}`

/**
 * The card. Sized in the same design-pixel scheme as the rest of the UI, and
 * laid out so it survives being shrunk: a thumbnail in a timeline is around a
 * third of this, which is why the title is two lines rather than one and the
 * body copy is short.
 */
function cardHtml(backdrop) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; overflow: hidden; background: #05070a; }
  body { font-family: 'Rajdhani', 'Bebas Neue', 'Helvetica Neue', Arial, sans-serif; color: #e8ece7; }
  .frame {
    position: absolute; inset: 0;
    background: url('${backdrop}') 60% 44% / cover no-repeat;
    filter: saturate(.94) contrast(1.05);
  }
  /* The title side is darkened, but not to black: the alley behind the type is
     half the reason to look at the card. */
  .scrim {
    position: absolute; inset: 0;
    background:
      linear-gradient(100deg, rgba(3,5,7,.88) 0%, rgba(3,5,7,.66) 30%, rgba(3,5,7,.16) 58%, rgba(3,5,7,0) 100%),
      linear-gradient(to top, rgba(3,5,7,.88) 0%, rgba(3,5,7,0) 32%),
      radial-gradient(120% 100% at 52% 44%, rgba(0,0,0,0) 42%, rgba(0,0,0,.5) 100%);
  }
  .grain {
    position: absolute; inset: 0; opacity: .045;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/></filter><rect width='160' height='160' filter='url(%23n)'/></svg>");
  }
  .plate { position: absolute; inset: 0; padding: 64px 72px; }
  .eyebrow {
    display: flex; align-items: center; gap: 14px;
    font-size: 19px; letter-spacing: 6px; text-transform: uppercase; color: #9ac48a;
  }
  .eyebrow::before { content: ''; width: 54px; height: 2px; background: #9ac48a; box-shadow: 0 0 10px rgba(154,196,138,.5); }
  h1 {
    margin-top: 22px; font-size: 128px; line-height: .88; font-weight: 700;
    letter-spacing: 2px; text-transform: uppercase;
    text-shadow: 0 6px 30px rgba(0,0,0,.8);
  }
  h1 .thin { display: block; font-weight: 300; color: #cfd8cd; letter-spacing: 8px; }
  .pitch {
    position: absolute; left: 72px; bottom: 146px; max-width: 520px;
    font-size: 25px; line-height: 1.32; color: rgba(232,236,231,.88);
    text-shadow: 0 2px 10px rgba(0,0,0,.95);
  }
  .rule { position: absolute; left: 72px; right: 72px; bottom: 104px; height: 1px; background: rgba(232,236,231,.18); }
  /* One line, always: a wrapped footer is what a rushed card looks like. */
  .foot {
    position: absolute; left: 72px; right: 72px; bottom: 58px;
    display: flex; align-items: center; justify-content: space-between;
    font-size: 17px; letter-spacing: 3px; text-transform: uppercase; white-space: nowrap;
  }
  .url { color: rgba(232,236,231,.92); flex: none; }
  .chips { display: flex; gap: 30px; color: rgba(232,236,231,.6); flex: none; }
  .chips span { position: relative; }
  .chips span + span::before { content: '·'; position: absolute; left: -18px; color: rgba(232,236,231,.38); }
</style></head>
<body>
  <div class="frame"></div>
  <div class="scrim"></div>
  <div class="grain"></div>
  <div class="plate">
    <div class="eyebrow">${EYEBROW}</div>
    <h1>${TITLE_TOP}<span class="thin">${TITLE_BOTTOM}</span></h1>
    <div class="pitch">${PITCH}</div>
    <div class="rule"></div>
    <div class="foot">
      <span class="url">${URL_LINE}</span>
      <span class="chips">${CHIPS.map((c) => `<span>${c}</span>`).join('')}</span>
    </div>
  </div>
</body></html>`
}

/** The icon, on its own page, at whatever size is being rasterised. */
function iconHtml(svg, size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; }
    html, body { width: ${size}px; height: ${size}px; overflow: hidden; }
    svg { display: block; width: ${size}px; height: ${size}px; }
  </style></head><body>${svg}</body></html>`
}

async function main() {
  if (!existsSync(PUBLIC)) mkdirSync(PUBLIC, { recursive: true })
  const profileDir = join(tmpdir(), `brand-assets-${process.pid}`)
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })

  const browser = await launch({
    executablePath: findChrome(),
    headless: true,
    userDataDir: profileDir,
    args: ['--no-sandbox', '--disable-crashpad', '--disable-breakpad', '--hide-scrollbars'],
    protocolTimeout: 120000,
  })

  try {
    const page = await browser.newPage()

    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 })
    await page.setContent(cardHtml(dataUri('loading-frame.jpg', 'image/jpeg')), { waitUntil: 'load' })
    await page.screenshot({ path: join(PUBLIC, 'social-card.jpg'), type: 'jpeg', quality: 88 })
    console.log('[brand] public/social-card.jpg 1200x630')

    const svg = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8')
    for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180]]) {
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
      await page.setContent(iconHtml(svg, size), { waitUntil: 'load' })
      await page.screenshot({ path: join(PUBLIC, name), type: 'png' })
      console.log(`[brand] public/${name} ${size}x${size}`)
    }
  } finally {
    await browser.close()
    rmSync(profileDir, { recursive: true, force: true })
  }
}

await main()
