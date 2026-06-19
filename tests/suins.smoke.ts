/**
 * SuiNS resolver smoke test (offline assertions only).
 * Does not hit the network — that would make this flaky in CI.
 */

import { isSuiName, _normalizeSuiName } from '../src/suins/resolver.js'

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('PASS:', msg)
}

assert(isSuiName('adeniyi.sui') === true,  "isSuiName('adeniyi.sui') === true")
assert(isSuiName('000.sui')      === true,  "isSuiName('000.sui') === true")
assert(isSuiName('ivan.sui')     === true,  "isSuiName('ivan.sui') === true")
assert(isSuiName('@x')           === true,  "isSuiName('@x') === true (shorthand)")
assert(isSuiName('0x123')        === false, "isSuiName('0x123') === false")
assert(isSuiName('hello')        === false, "isSuiName('hello') === false")
assert(isSuiName('')             === false, "isSuiName('') === false")
assert(isSuiName(null as any)    === false, "isSuiName(null) === false")

assert(_normalizeSuiName('@x')       === 'x.sui',        "@x normalizes to x.sui")
assert(_normalizeSuiName('  @ivan ') === 'ivan.sui',     "  @ivan  normalizes to ivan.sui")
assert(_normalizeSuiName('Adeniyi.SUI') === 'adeniyi.sui', "case folded to lower")

console.log('\nALL SUINS SMOKE ASSERTIONS PASSED')
