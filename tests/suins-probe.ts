import { resolveSuiName } from '../src/suins/resolver.js'
;(async () => {
  for (const name of ['mysten.sui', 'adeniyi.sui', 'suins.sui', 'notarealname12345.sui']) {
    const addr = await resolveSuiName(name)
    console.log(name.padEnd(25), '→', addr ?? 'NULL')
  }
})()
