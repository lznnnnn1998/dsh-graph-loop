// UI smoke for the Graph tab. Boots the Web GUI, dismisses the preview notice,
// starts a session from the composer, waits for the graph turn, then verifies the
// Chat/Trajectory/Graph tabs and screenshots the Graph panel.
import puppeteer from 'puppeteer-core'

const [base, token, apiPort] = process.argv.slice(2)
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const clickText = (page, text) => page.evaluate((wanted) => {
  const buttons = [...document.querySelectorAll('button, [role="button"], [role="tab"]')]
  const target = buttons.find(element => element.textContent && element.textContent.trim() === wanted)
  if (target) { target.click(); return true }
  return false
}, text)

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const page = await browser.newPage()
page.on('pageerror', error => console.error('PAGEERROR', String(error).slice(0, 300)))
page.on('console', message => { if (message.type() === 'error') console.error('CONSOLE', message.text().slice(0, 300)) })
await page.setViewport({ width: 1600, height: 1000 })
await page.goto(`${base}/?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(resolve => setTimeout(resolve, 3500))

// Dismiss the preview notice if present.
await clickText(page, 'Continue')
await new Promise(resolve => setTimeout(resolve, 800))

// Type into the composer to start a session (blank session composer is resident).
const composer = await page.$('textarea, [contenteditable="true"]')
if (composer === null) {
  console.error('FAIL: no composer found')
  await page.screenshot({ path: 'preview/graph-tab-live.png' })
  process.exit(1)
}
await composer.click()
await page.keyboard.type('explain how the config loader works')
await page.keyboard.press('Enter')
await new Promise(resolve => setTimeout(resolve, 9000))

const text = await page.evaluate(() => document.body.innerText)
const tabs = ['Chat', 'Trajectory', 'Graph'].filter(label => text.includes(label))
console.log('tabs:', tabs.join(','))

const graphClicked = await clickText(page, 'Graph')
console.log('clicked Graph:', graphClicked)
await new Promise(resolve => setTimeout(resolve, 2500))
const graphText = await page.evaluate(() => document.body.innerText)
console.log('graph panel:', graphText.includes('INFORMATION FLOW') || graphText.includes('Information flow') || graphText.includes('No graph run yet'))
await page.screenshot({ path: 'preview/graph-tab-live.png' })
console.log('screenshot: preview/graph-tab-live.png')
await browser.close()
if (!tabs.includes('Graph')) { console.error('FAIL: Graph tab missing'); process.exit(1) }
