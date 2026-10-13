/**
 * Zed's native-app sign-in handshake, without any harness imports.
 *
 * DSH generates an RSA-2048 keypair, sends zed.dev the public half in the
 * sign-in URL, and the browser posts the access token back to a loopback port
 * encrypted to that key (RSA-OAEP/SHA-256; RSAES-PKCS1-v1_5 for legacy
 * senders). Getting the padding or digest wrong fails the handshake silently,
 * so the round trip is covered by test/signin.test.mjs.
 */

import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto'

export const ZED_WEB_URL = 'https://zed.dev'

/** One generated handshake keypair, in the shapes the sign-in URL and callback need. */
export interface ZedSignInKeypair {
  /** PKCS#1 DER, base64url, unpadded — exactly what `native_app_public_key` carries. */
  publicKeyDerBase64Url: string
  /** PKCS#1 PEM, kept in memory for the length of one attempt. */
  privateKeyPem: string
}

export function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBase64url(text: string): Buffer {
  let base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4 !== 0) base64 += '='
  return Buffer.from(base64, 'base64')
}

/** Public key as the sign-in URL carries it: PKCS#1 DER, base64url, unpadded. */
export function generateSignInKeypair(): ZedSignInKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'der' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  return { publicKeyDerBase64Url: base64url(publicKey), privateKeyPem: privateKey }
}

export function signInUrl(port: number, publicKeyDerBase64Url: string): string {
  const url = new URL('/native_app_signin', ZED_WEB_URL)
  url.searchParams.set('native_app_port', String(port))
  url.searchParams.set('native_app_public_key', publicKeyDerBase64Url)
  return url.toString()
}

/**
 * A Zed token is an opaque header-safe string. The shape check is what makes
 * the legacy padding branch safe: OpenSSL 3 rejects a bad PKCS#1 v1.5 padding
 * with random bytes instead of an error, so garbage must be refused here.
 */
function looksLikeToken(text: string): boolean {
  return text.length >= 16 && /^[\x21-\x7e]+$/.test(text)
}

/**
 * Decrypt one `access_token` query value.
 * @throws when the ciphertext was produced for a different key.
 */
export function decryptAccessToken(encryptedBase64Url: string, privateKeyPem: string): string {
  const encrypted = decodeBase64url(encryptedBase64Url)
  let legacyError: unknown
  try {
    const token = privateDecrypt(
      { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      encrypted,
    ).toString('utf8')
    if (looksLikeToken(token)) return token
  } catch (error) {
    legacyError = error
  }
  try {
    const token = privateDecrypt(
      { key: privateKeyPem, padding: constants.RSA_PKCS1_PADDING },
      encrypted,
    ).toString('utf8')
    if (looksLikeToken(token)) return token
  } catch (error) {
    legacyError = error
  }
  throw legacyError ?? new Error('Zed sign-in callback did not decrypt to an access token for this key')
}
