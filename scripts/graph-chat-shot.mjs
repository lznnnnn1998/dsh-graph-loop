// Screenshot the authenticated /graph-chat page.
//
// The page sits behind the host Connection trust fence, so a bare Chrome
// `--screenshot` would capture the 401 body. This boots one browser, opens the
// launch URL once to receive the signed session cookie, then navigates to the
// page and captures it.
import puppeteer from 'puppeteer-core'

const [base, launch, out] = process.argv.slice(2)
if (base === undefined || launch === undefined || out === undefined) {
  console.error('usage: node scripts/graph-chat-shot.mjs <base-url> <launch-url-with-token> <output.png>')
  process.exit(2)
}

const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  // First navigation exchanges the launch token for the session cookie.
  await page.goto(launch, { waitUntil: 'networkidle2', timeout: 60_000 })
  await page.goto(`${base}/graph-chat`, { waitUntil: 'networkidle2', timeout: 60_000 })
  // The page polls /api/state; give the first render a moment to settle.
  await new Promise(resolve => setTimeout(resolve, 3_000))
  const title = await page.evaluate(() => document.body.innerText.slice(0, 400))
  if (!title.includes('Graph Chat')) {
    console.error(`FAIL: page did not render graph chat:\n${title}`)
    process.exitCode = 1
  }
  await page.screenshot({ path: out })
  console.log(`screenshot: ${out}`)
} finally {
  await browser.close()
}
