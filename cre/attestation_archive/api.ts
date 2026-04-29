import { consensusIdenticalAggregation, HTTPClient, Runtime, type NodeRuntime, type HTTPSendRequester } from '@chainlink/cre-sdk'
import type { Config } from './config.js'
import { stringToBase64 } from '../library/utils.js'

/**
 * Vlayer verification result - raw response from vlayer API
 * Matches the exact structure returned by the vlayer /verify endpoint
 */
export interface VlayerVerificationResult {
	success: boolean
	serverDomain: string
	notaryKeyFingerprint: string
	request: {
		body: string | null
		headers: Array<[string, string]>
		method: string
		raw: string
		url: string
		version: string
	}
	response: {
		body: string
		headers: Array<[string, string]>
		raw: string
		status: number
		version: string
	}
}

/**
 * Vlayer verification result used for consensus.
 * Similar to the raw response from the vlayer API, but with no optional fields as those are not supported by the consensus mechanism.
 */
export interface VlayerVerificationResultConsensus {
	success: boolean
	serverDomain: string
	notaryKeyFingerprint: string
	request: {
		headers: Array<[string, string]>
		method: string
		raw: string
		url: string
		version: string
	}
	response: {
		body: string
		headers: Array<[string, string]>
		raw: string
		status: number
		version: string
	}
}

/**
 * Helper function to verify web proof using vlayer API
 * Returns the full raw vlayer response for storage and later verification
 * Uses HTTPClient for proper CRE workflow HTTP requests
 */
function verifyClaimWithVlayerInternal(
	nodeRuntime: NodeRuntime<Config>,
	proof: { data: string; version: string; meta: { notaryUrl: string } },
	clientId: string,
	authToken: string
): VlayerVerificationResultConsensus {
	const vlayerUrl = nodeRuntime.config.vlayerEndpoint.url

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	}

	if (clientId) {
		headers['x-client-id'] = clientId
	}

	if (authToken) {
		headers['Authorization'] = `Bearer ${authToken}`
	}

	// Use HTTPClient for CRE workflows
	const httpClient = new HTTPClient()
	
	// Encode body as base64 (required by HTTPClient)
	const body = stringToBase64(JSON.stringify(proof))
	
	const request = {
		url: vlayerUrl,
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
		const errorBody = new TextDecoder().decode(response.body)
		throw new Error(`vlayer verification request failed with status code ${response.statusCode}: ${errorBody}`)
	}

	const bodyText = new TextDecoder().decode(response.body)
	const fullResponse = JSON.parse(bodyText)

	// The CRE consensus step does not support optional fields, so we need to create a new interface that does not include optional fields.
	// In practice, this is the 'request.body' field, which is returned as null.
	// Because it is important to end up with the original response for cryptographic correctness,
	// we reconstruct the original response by setting the 'request.body' field as null after consensus.
	const vlayerVerificationResult: VlayerVerificationResultConsensus = {
		success: fullResponse.success,
		serverDomain: fullResponse.serverDomain,
		notaryKeyFingerprint: fullResponse.notaryKeyFingerprint,
		request: {
			headers: fullResponse.request.headers,
			method: fullResponse.request.method,
			raw: fullResponse.request.raw,
			url: fullResponse.request.url,
			version: fullResponse.request.version,
		},
		response: {
			body: fullResponse.response.body,
			headers: fullResponse.response.headers,
			raw: fullResponse.response.raw,
			status: fullResponse.response.status,
			version: fullResponse.response.version,
		},
	}

	return vlayerVerificationResult
}

/**
 * Verify claim data with vlayer
 */
export async function verifyClaimWithVlayer(
	runtime: Runtime<Config>,
	proofData: any
): Promise<VlayerVerificationResult> {
	// Get vlayer credentials - client ID from config, auth token from secrets
	const vlayerClientId = runtime.config.vlayerEndpoint.clientId
	const vlayerAuthToken = runtime.getSecret({ id: 'vlayerauthtoken' }).result().value as string

	// Use runInNodeMode to execute HTTP request across DON with consensus
	const vlayerVerificationResultConsensus = runtime.runInNodeMode(
		(nodeRuntime: NodeRuntime<Config>) => verifyClaimWithVlayerInternal(
			nodeRuntime,
			proofData,
			vlayerClientId,
			vlayerAuthToken
		),
		consensusIdenticalAggregation<VlayerVerificationResultConsensus>()
	)().result()

	const vlayerVerificationResult: VlayerVerificationResult = {
		success: vlayerVerificationResultConsensus.success,
		serverDomain: vlayerVerificationResultConsensus.serverDomain,
		notaryKeyFingerprint: vlayerVerificationResultConsensus.notaryKeyFingerprint,
		request: {
			body: null,
			headers: vlayerVerificationResultConsensus.request.headers,
			method: vlayerVerificationResultConsensus.request.method,
			raw: vlayerVerificationResultConsensus.request.raw,
			url: vlayerVerificationResultConsensus.request.url,
			version: vlayerVerificationResultConsensus.request.version,
		},
		response: vlayerVerificationResultConsensus.response,
	}

	if (!vlayerVerificationResult.success) {
		throw new Error('vlayer verification failed')
	}
	
	return vlayerVerificationResult
}


