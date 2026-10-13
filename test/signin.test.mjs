import assert from 'node:assert/strict'
import { constants, generateKeyPairSync, publicEncrypt } from 'node:crypto'
import test from 'node:test'
import { decryptAccessToken, generateSignInKeypair, signInUrl } from '../lib/signin.js'

const TOKEN = 'zed_master_access_token_abc123'

/** Encrypt the way zed.dev does: the sign-in page holds only the public key. */
function encryptFor(derBase64Url, token, oaep) {
  let base64 = derBase64Url.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4 !== 0) base64 += '='
  const publicKey = {
    key: Buffer.from(base64, 'base64'),
    format: 'der',
    type: 'pkcs1',
    padding: oaep ? constants.RSA_PKCS1_OAEP_PADDING : constants.RSA_PKCS1_PADDING,
    ...(oaep ? { oaepHash: 'sha256' } : {}),
  }
  return publicEncrypt(publicKey, Buffer.from(token, 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

test('sign-in URL carries the port and an unpadded PKCS#1 public key', () => {
  const { publicKeyDerBase64Url } = generateSignInKeypair()
  const url = new URL(signInUrl(48921, publicKeyDerBase64Url))

  assert.equal(url.origin, 'https://zed.dev')
  assert.equal(url.pathname, '/native_app_signin')
  assert.equal(url.searchParams.get('native_app_port'), '48921')
  assert.equal(url.searchParams.get('native_app_public_key'), publicKeyDerBase64Url)
  assert.ok(!publicKeyDerBase64Url.includes('='), 'base64url must be unpadded')
  assert.ok(!publicKeyDerBase64Url.includes('+') && !publicKeyDerBase64Url.includes('/'))
})

test('decrypts the OAEP/SHA-256 callback token', () => {
  const keypair = generateSignInKeypair()
  const encrypted = encryptFor(keypair.publicKeyDerBase64Url, TOKEN, true)
  assert.equal(decryptAccessToken(encrypted, keypair.privateKeyPem), TOKEN)
})

test('falls back to legacy PKCS#1 v1.5 padding', () => {
  const keypair = generateSignInKeypair()
  const encrypted = encryptFor(keypair.publicKeyDerBase64Url, TOKEN, false)
  assert.equal(decryptAccessToken(encrypted, keypair.privateKeyPem), TOKEN)
})

test('refuses a token encrypted for another key', () => {
  const mine = generateSignInKeypair()
  const theirs = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'der' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const encrypted = publicEncrypt(
    {
      key: theirs.publicKey,
      format: 'der',
      type: 'pkcs1',
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(TOKEN, 'utf8'),
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  assert.throws(() => decryptAccessToken(encrypted, mine.privateKeyPem))
})
