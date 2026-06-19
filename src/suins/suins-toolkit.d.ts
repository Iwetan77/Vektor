declare module '@suins/toolkit' {
  export class SuinsClient {
    constructor(provider: unknown, options?: { networkType?: string; contractObjects?: unknown })
    getAddress(domain: string): Promise<string | undefined>
    getName(address: string): Promise<string | undefined>
  }
}
