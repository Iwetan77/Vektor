import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  jwtToAddress,
  getZkLoginSignature,
} from '@mysten/sui/zklogin'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'
import type { ZkLoginSession, ZkProof } from '../types.js'

/** Serialisable snapshot of the ephemeral keypair + nonce state — safe to put in sessionStorage. */
export interface ZkEphemeralState {
  /** Base-64 encoded 32-byte Ed25519 private key */
  privKey:    string
  randomness: string
  maxEpoch:   number
}

const PROVER_URL = 'https://prover-dev.mystenlabs.com/v1'

export interface ZkLoginProviderConfig {
  /** OAuth client ID registered with the provider */
  clientId: string
  /** Redirect URI registered with the provider */
  redirectUri: string
  /** OAuth provider. Defaults to 'google'. */
  provider?: 'google' | 'facebook' | 'twitch'
}

/**
 * ZkLogin auth — lets users authenticate with an OAuth provider (Google, Facebook, Twitch)
 * and derive a deterministic Sui address without ever exposing a private key.
 *
 * Flow:
 *  1. generateLoginUrl()  → redirect user to OAuth
 *  2. handleCallback(jwt) → after redirect, exchange JWT for a ZK proof
 *  3. session.address     → use as senderAddress in Vektor intents
 *  4. signTransaction()   → sign PTBs with the ephemeral key + ZK proof
 *
 * The ephemeral keypair is valid until `maxEpoch`. Sessions should be refreshed
 * before that epoch is reached.
 */
export class ZkLoginAuth {
  private suiClient: SuiJsonRpcClient
  private ephemeralKeypair: Ed25519Keypair | null = null
  private randomness: string | null = null
  private maxEpoch: number = 0

  constructor(
    private readonly network: 'mainnet' | 'testnet',
    private readonly providerConfig: ZkLoginProviderConfig,
  ) {
    this.suiClient = new SuiJsonRpcClient({
      url: getJsonRpcFullnodeUrl(network),
    } as any)
  }

  /**
   * Step 1 — Generate an OAuth login URL.
   *
   * Store the returned `nonce` and call `handleCallback` with the JWT
   * after the OAuth redirect completes.
   */
  async generateLoginUrl(): Promise<{ url: string; nonce: string }> {
    // Fetch current epoch to set ephemeral key expiry
    const { epoch } = await this.suiClient.getLatestSuiSystemState()
    this.maxEpoch = Number(epoch) + 10  // valid for ~10 epochs

    // Generate ephemeral keypair and randomness
    this.ephemeralKeypair = new Ed25519Keypair()
    this.randomness = generateRandomness()

    const nonce = generateNonce(
      this.ephemeralKeypair.getPublicKey(),
      this.maxEpoch,
      this.randomness,
    )

    const provider = this.providerConfig.provider ?? 'google'
    const url = this.buildOAuthUrl(provider, nonce)

    return { url, nonce }
  }

  /**
   * Step 2 — Exchange the JWT (from OAuth redirect) for a ZK proof.
   *
   * Calls the Mysten Labs prover service to generate the ZK proof,
   * then returns a complete ZkLoginSession.
   *
   * @param jwt     The JWT from the OAuth provider's response
   * @param salt    User-specific salt (store this — same salt = same Sui address)
   */
  async handleCallback(jwt: string, salt: string): Promise<ZkLoginSession> {
    if (!this.ephemeralKeypair || !this.randomness) {
      throw new Error('Call generateLoginUrl() before handleCallback()')
    }

    // Derive Sui address from JWT + salt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const address = (jwtToAddress as any)(jwt, salt)

    // Get the extended ephemeral public key for the prover
    const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(
      this.ephemeralKeypair.getPublicKey(),
    )

    // Request ZK proof from Mysten Labs prover
    const proof = await this.fetchZkProof({
      jwt,
      extendedEphemeralPublicKey,
      maxEpoch: this.maxEpoch,
      jwtRandomness: this.randomness,
      salt,
      keyClaimName: 'sub',
    })

    return {
      ephemeralKeypair: this.ephemeralKeypair,
      jwt,
      nonce: generateNonce(this.ephemeralKeypair.getPublicKey(), this.maxEpoch, this.randomness),
      address,
      proof,
      maxEpoch: this.maxEpoch,
    }
  }

  /**
   * Step 3 — Sign a transaction with the zkLogin session.
   *
   * Returns the serialized zkLogin signature that can be submitted to the network.
   */
  async signTransaction(session: ZkLoginSession, txBytes: Uint8Array): Promise<string> {
    const { signature: ephemeralSignature } = await session.ephemeralKeypair.signTransaction(txBytes)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getZkLoginSignature as any)({
      inputs: {
        ...session.proof,
        addressSeed: (jwtToAddress as any)(session.jwt, ''),
      },
      maxEpoch: session.maxEpoch,
      userSignature: ephemeralSignature,
    })
  }

  /**
   * Export the current ephemeral state so it can be persisted across an OAuth redirect.
   * Save the result to sessionStorage before sending the user to the OAuth provider;
   * restore it with `ZkLoginAuth.fromEphemeralState()` on the callback page.
   */
  exportEphemeralState(): ZkEphemeralState {
    if (!this.ephemeralKeypair || !this.randomness) {
      throw new Error('Call generateLoginUrl() before exportEphemeralState()')
    }
    return {
      // getSecretKey() returns the Bech32-encoded private key string in @mysten/sui v2
      privKey:    this.ephemeralKeypair.getSecretKey(),
      randomness: this.randomness,
      maxEpoch:   this.maxEpoch,
    }
  }

  /**
   * Reconstruct a `ZkLoginAuth` instance from a previously exported ephemeral state.
   * Call this on the OAuth callback page before calling `handleCallback()`.
   */
  static fromEphemeralState(
    network: 'mainnet' | 'testnet',
    config:  ZkLoginProviderConfig,
    state:   ZkEphemeralState,
  ): ZkLoginAuth {
    const auth = new ZkLoginAuth(network, config)
    // fromSecretKey accepts the Bech32 string returned by getSecretKey()
    auth.ephemeralKeypair = Ed25519Keypair.fromSecretKey(state.privKey as any)
    auth.randomness       = state.randomness
    auth.maxEpoch         = state.maxEpoch
    return auth
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private buildOAuthUrl(provider: 'google' | 'facebook' | 'twitch', nonce: string): string {
    const { clientId, redirectUri } = this.providerConfig
    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  redirectUri,
      response_type: 'id_token',
      scope:         'openid email profile',
      nonce,
    })

    const endpoints: Record<string, string> = {
      google:   'https://accounts.google.com/o/oauth2/v2/auth',
      facebook: 'https://www.facebook.com/v17.0/dialog/oauth',
      twitch:   'https://id.twitch.tv/oauth2/authorize',
    }

    return `${endpoints[provider]}?${params}`
  }

  private async fetchZkProof(body: {
    jwt: string
    extendedEphemeralPublicKey: string
    maxEpoch: number
    jwtRandomness: string
    salt: string
    keyClaimName: string
  }): Promise<ZkProof> {
    const response = await fetch(PROVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`ZK prover error ${response.status}: ${text}`)
    }

    return response.json() as Promise<ZkProof>
  }
}
