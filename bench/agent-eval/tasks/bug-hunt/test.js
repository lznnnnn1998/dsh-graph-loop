import { double } from './utils.js'
if (double(3) !== 6) {
  console.error('FAIL: double(3) =', double(3))
  process.exit(1)
}
console.log('PASS')
