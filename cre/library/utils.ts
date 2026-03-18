/**
 * Shared utility functions for encoding and IPFS hash conversion
 * Used by both mhyper_attestation and mhyper_verification workflows
 */

// ============================================================================
// Base64 encoding (pure JS - neither Buffer nor btoa exist in CRE QuickJS)
// ============================================================================

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Encode a string to base64
 */
export function stringToBase64(str: string): string {
	const bytes = new TextEncoder().encode(str)
	return uint8ArrayToBase64(bytes)
}

/**
 * Encode a Uint8Array to base64
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
	let result = ''
	const len = bytes.length
	for (let i = 0; i < len; i += 3) {
		const b0 = bytes[i]
		const b1 = i + 1 < len ? bytes[i + 1] : 0
		const b2 = i + 2 < len ? bytes[i + 2] : 0

		result += BASE64_CHARS[(b0 >> 2) & 0x3f]
		result += BASE64_CHARS[((b0 << 4) | (b1 >> 4)) & 0x3f]
		result += i + 1 < len ? BASE64_CHARS[((b1 << 2) | (b2 >> 6)) & 0x3f] : '='
		result += i + 2 < len ? BASE64_CHARS[b2 & 0x3f] : '='
	}
	return result
}

// ============================================================================
// Base58 encoding
// ============================================================================

/**
 * Base58 encoding implementation
 * Based on bs58 library (https://github.com/cryptocoinjs/bs58)
 * Inlined for WASM/QuickJS compatibility since external npm packages may not be bundled
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(source: Uint8Array): string {
	if (source.length === 0) return ''
	
	// Count leading zeros
	let zeros = 0
	let length = 0
	let pbegin = 0
	const pend = source.length
	
	while (pbegin !== pend && source[pbegin] === 0) {
		pbegin++
		zeros++
	}
	
	// Allocate enough space in big-endian base58 representation
	const size = ((pend - pbegin) * 138 / 100 + 1) >>> 0
	const b58 = new Uint8Array(size)
	
	// Process the bytes
	while (pbegin !== pend) {
		let carry = source[pbegin]
		
		// Apply "b58 = b58 * 256 + ch"
		let i = 0
		for (let it = size - 1; (carry !== 0 || i < length) && (it !== -1); it--, i++) {
			carry += (256 * b58[it]) >>> 0
			b58[it] = (carry % 58) >>> 0
			carry = (carry / 58) >>> 0
		}
		
		if (carry !== 0) throw new Error('Non-zero carry')
		length = i
		pbegin++
	}
	
	// Skip leading zeros in base58 result
	let it = size - length
	while (it !== size && b58[it] === 0) {
		it++
	}
	
	// Translate the result into a string
	let str = '1'.repeat(zeros)
	for (; it < size; ++it) {
		str += BASE58_ALPHABET.charAt(b58[it])
	}
	
	return str
}

function base58Decode(source: string): Uint8Array {
	if (source.length === 0) return new Uint8Array(0)
	
	// Count leading zeros
	let zeros = 0
	let length = 0
	let pbegin = 0
	const pend = source.length
	
	while (source[pbegin] === '1') {
		pbegin++
		zeros++
	}
	
	// Allocate enough space in big-endian base256 representation
	const size = ((pend - pbegin) * 733 / 1000 + 1) >>> 0
	const b256 = new Uint8Array(size)
	
	// Process the characters
	while (pbegin !== pend) {
		const ch = source[pbegin]
		let carry = BASE58_ALPHABET.indexOf(ch)
		
		if (carry === -1) throw new Error('Invalid base58 character')
		
		// Apply "b256 = b256 * 58 + carry"
		let i = 0
		for (let it = size - 1; (carry !== 0 || i < length) && (it !== -1); it--, i++) {
			carry += (58 * b256[it]) >>> 0
			b256[it] = (carry % 256) >>> 0
			carry = (carry / 256) >>> 0
		}
		
		if (carry !== 0) throw new Error('Non-zero carry')
		length = i
		pbegin++
	}
	
	// Skip leading zeros in base256 result
	let it = size - length
	while (it !== size && b256[it] === 0) {
		it++
	}
	
	// Prepend leading zeros
	const result = new Uint8Array(zeros + (size - it))
	result.fill(0, 0, zeros)
	
	let resultIndex = zeros
	for (; it < size; ++it) {
		result[resultIndex++] = b256[it]
	}
	
	return result
}

/**
 * Convert a hex hash to an IPFS CID (base58 encoded)
 * Adds the multihash prefix 0x1220 (SHA-256, 32 bytes) and encodes to base58
 */
export function hashToIPFSCid(hexHash: string): string {
	// Remove 0x prefix if present
	const cleanHex = hexHash.startsWith('0x') ? hexHash.slice(2) : hexHash
	
	// Add multihash prefix: 0x12 (SHA-256) + 0x20 (32 bytes length)
	const multihash = '1220' + cleanHex
	
	// Convert hex to bytes
	const bytes = new Uint8Array(multihash.length / 2)
	for (let i = 0; i < multihash.length; i += 2) {
		bytes[i / 2] = parseInt(multihash.substring(i, i + 2), 16)
	}
	
	// Base58 encode
	return base58Encode(bytes)
}

/**
 * Convert an IPFS CID (base58 encoded) back to a hex hash (bytes32)
 * Removes the multihash prefix 0x1220 and returns the raw hash
 */
export function ipfsCidToHash(cid: string): `0x${string}` {
	// Decode base58
	const bytes = base58Decode(cid)
	
	// Check multihash prefix (0x1220 = SHA-256, 32 bytes)
	if (bytes.length < 34) {
		throw new Error('Invalid IPFS CID: too short')
	}
	
	if (bytes[0] !== 0x12 || bytes[1] !== 0x20) {
		throw new Error('Invalid IPFS CID: expected SHA-256 multihash prefix (0x1220)')
	}
	
	// Extract the 32-byte hash (skip the 2-byte prefix)
	const hash = bytes.slice(2, 34)
	
	// Convert to hex string
	let hex = '0x'
	for (let i = 0; i < hash.length; i++) {
		hex += hash[i].toString(16).padStart(2, '0')
	}
	
	return hex as `0x${string}`
}

// ============================================================================
// Canonical JSON serialization
// ============================================================================

/**
 * Recursively sort all object keys alphabetically for deterministic JSON output.
 * Arrays preserve element order; only object key order is normalized.
 */
export function sortObjectKeys(obj: unknown): unknown {
	if (obj === null || obj === undefined || typeof obj !== 'object') {
		return obj
	}
	if (Array.isArray(obj)) {
		return obj.map(sortObjectKeys)
	}
	const sorted: Record<string, unknown> = {}
	for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
		sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key])
	}
	return sorted
}

/**
 * Deterministic JSON.stringify with sorted keys.
 * Guarantees identical output regardless of property insertion order.
 */
export function canonicalStringify(data: unknown, indent?: number): string {
	return JSON.stringify(sortObjectKeys(data), null, indent)
}
