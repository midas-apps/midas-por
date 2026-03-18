/**
 * Shared IPFS functions for both mhyper_attestation and mhyper_verification workflows
 */

import { HTTPClient, type NodeRuntime } from '@chainlink/cre-sdk'
import * as pako from 'pako'
import { stringToBase64, uint8ArrayToBase64, canonicalStringify } from './utils.js'

/**
 * Generic config interface for IPFS operations
 */
export interface IPFSConfig {
	ipfsHttpEndpoint: {
		url: string
	}
	ipfsRpcEndpoint: {
		url: string
		username: string
	}
}

// ============================================================================
// Compression Utilities
// ============================================================================

/**
 * Compress JSON data to gzipped bytes
 * 
 * @param data - JSON data to compress
 * @returns Compressed bytes
 */
export function compressJson(data: any): Uint8Array {
	const jsonString = canonicalStringify(data, 2)
	const jsonBytes = new TextEncoder().encode(jsonString)
	return pako.gzip(jsonBytes)
}

/**
 * Decompress gzipped bytes to JSON data
 * 
 * @param compressedData - Compressed bytes
 * @returns Parsed JSON data
 */
export function decompressJson(compressedData: Uint8Array): any {
	const decompressedBytes = pako.ungzip(compressedData)
	const jsonString = new TextDecoder().decode(decompressedBytes)
	return JSON.parse(jsonString)
}

// ============================================================================
// IPFS Fetch Functions
// ============================================================================

/**
 * Fetch raw bytes from IPFS
 * 
 * @param nodeRuntime - NodeRuntime context for HTTP requests
 * @param ipfsCid - IPFS CID to fetch
 * @returns Raw bytes from IPFS
 */
export function fetchFromIpfs<T extends IPFSConfig>(
	nodeRuntime: NodeRuntime<T>,
	ipfsCid: string
): Uint8Array {
	const baseUrl = nodeRuntime.config.ipfsHttpEndpoint.url
	const ipfsUrl = `${baseUrl}/ipfs/${ipfsCid}`

	const httpClient = new HTTPClient()
	const request = {
		url: ipfsUrl,
		method: 'GET' as const,
		headers: {},
		timeout: '10s',  // 10 second timeout (CRE limit)
	}

	const response = httpClient.sendRequest(nodeRuntime, request).result()

	if (response.statusCode !== 200) {
		throw new Error(`Failed to fetch from IPFS: ${response.statusCode}`)
	}

	return response.body
}

// ============================================================================
// IPFS Upload Functions
// ============================================================================

/**
 * Push binary data to IPFS using authenticated Kubo RPC API
 * 
 * @param nodeRuntime - NodeRuntime context for HTTP requests
 * @param data - Binary data to upload
 * @param ipfsUsername - IPFS username for authentication
 * @param ipfsPassword - IPFS password for authentication
 * @param filename - Filename for the uploaded content
 * @param contentType - Content-Type header for the file
 * @returns IPFS CID (hash) of the uploaded content
 */
export function pushToIpfs<T extends IPFSConfig>(
	nodeRuntime: NodeRuntime<T>,
	data: Uint8Array,
	ipfsUsername: string,
	ipfsPassword: string,
	filename: string = 'data.bin',
	contentType: string = 'application/octet-stream'
): string {
	const ipfsRpcUrl = nodeRuntime.config.ipfsRpcEndpoint.url

	// Create multipart/form-data body with binary data
	const boundary = '----CREFormBoundary7MA4YWxkTrZu0gW'
	
	// Build multipart body parts
	const header = [
		`--${boundary}`,
		`Content-Disposition: form-data; name="file"; filename="${filename}"`,
		`Content-Type: ${contentType}`,
		``,
		``
	].join('\r\n')
	
	const footer = [
		``,
		`--${boundary}--`,
		``
	].join('\r\n')
	
	// Combine header, data, and footer
	const headerBytes = new TextEncoder().encode(header)
	const footerBytes = new TextEncoder().encode(footer)
	
	const totalLength = headerBytes.length + data.length + footerBytes.length
	const multipartBodyBytes = new Uint8Array(totalLength)
	multipartBodyBytes.set(headerBytes, 0)
	multipartBodyBytes.set(data, headerBytes.length)
	multipartBodyBytes.set(footerBytes, headerBytes.length + data.length)

	// Create Basic Auth header
	const authCredentials = `${ipfsUsername}:${ipfsPassword}`
	const authHeader = `Basic ${stringToBase64(authCredentials)}`

	const headers: Record<string, string> = {
		'Content-Type': `multipart/form-data; boundary=${boundary}`,
		'Authorization': authHeader,
	}

	const httpClient = new HTTPClient()
	
	// Encode body as base64 (required by HTTPClient for POST)
	const body = uint8ArrayToBase64(multipartBodyBytes)
	
	const request = {
		url: `${ipfsRpcUrl}/api/v0/add`,
		method: 'POST' as const,
		headers,
		body,
		timeout: '10s',  // 10 second timeout (CRE limit)
		cacheSettings: {
			store: true,  // Enable reading from cache
			maxAge: '30s'  // allows nodes to share results during that time
		}
	}

	const response = httpClient.sendRequest(nodeRuntime, request).result()

	if (response.statusCode !== 200) {
		throw new Error(`IPFS add request failed: ${response.statusCode}`)
	}

	// Parse response to get CID
	const bodyText = new TextDecoder().decode(response.body)
	const result = JSON.parse(bodyText)
	
	if (!result.Hash) {
		throw new Error('IPFS response missing Hash field')
	}

	return result.Hash
}
