import {
	bytesToHex,
	handler,
	EVMClient,
	HTTPCapability,
	type EVMLog,
	type HTTPPayload,
	Runner,
	type Runtime,
	type NodeRuntime,
	consensusIdenticalAggregation,
	hexToBase64,
	TxStatus,
	HTTPClient,
	encodeCallMsg,
	decodeJson,
} from '@chainlink/cre-sdk'
import { decodeAbiParameters, encodeFunctionData, decodeFunctionResult, zeroAddress } from 'viem'
import { configSchema, type Config } from './config.js'
import { hashToIPFSCid, ipfsCidToHash, stringToBase64 } from '../library/utils.js'
import { verifyAttestation } from '@save/core'
import type { AttestationData, VerificationData, HttpClient, HttpResponse } from '@save/core'
import { fetchFromIpfs, pushToIpfs, compressJson, decompressJson } from '../library/ipfs.js'
import { getNetworkByChainSelector, CRE_CONFIDENCE_MAP, getBlockNumberByConfidence } from '../library/config-schemas.js'
import { SaveRegistryWithClaim } from '../contracts/abi/SaveRegistryWithClaim.js'

/**
 * HttpClient adapter for CRE's HTTPClient.
 * Uses runInNodeMode + consensusIdenticalAggregation for DON consensus.
 */
class CreHttpClient implements HttpClient {
	constructor(private runtime: Runtime<Config>) {}

	async post(url: string, body: string, headers: Record<string, string>): Promise<HttpResponse> {
		const result = this.runtime.runInNodeMode(
			(nodeRuntime: NodeRuntime<Config>) => {
				const httpClient = new HTTPClient()
				const bodyBase64 = stringToBase64(body)
				const request = {
					url,
					method: 'POST' as const,
					headers,
					body: bodyBase64,
					timeout: '10s',
					cacheSettings: {
						store: true,
						maxAge: '30s'
					}
				}
				const response = httpClient.sendRequest(nodeRuntime, request).result()
				const responseBody = new TextDecoder().decode(response.body)
				return { status: response.statusCode, body: responseBody }
			},
			consensusIdenticalAggregation<HttpResponse>()
		)().result()

		return result
	}
}

export async function main() {
	try {
		const runner = await Runner.newRunner<Config>({
			configSchema,
		})
		await runner.run(initWorkflow)
	} catch (error) {
		console.error('Fatal error in main:', error)
		throw error
	}
}

const initWorkflow = (config: Config) => {
	const network = getNetworkByChainSelector(config.attestationSetLogTrigger.chainSelectorName)
	
	if (!network) {
		throw new Error(
			`Network not found for chain selector name: ${config.attestationSetLogTrigger.chainSelectorName}`
		)
	}

	const evmClient = new EVMClient(network.chainSelector.selector)

	// Convert hex topics to base64
	const topicFilters = config.attestationSetLogTrigger.topics.map((topicFilter: any) => ({
		values: topicFilter.values.map((topic: string) => hexToBase64(topic))
	}))

	// Map confidence level to CRE format
	const confidenceLevel = CRE_CONFIDENCE_MAP[config.attestationSetLogTrigger.confidence]

	// HTTP trigger for manual verification
	const httpCapability = new HTTPCapability()

	return [
		handler(
			evmClient.logTrigger({
				addresses: [hexToBase64(config.attestationSetLogTrigger.address)],
				topics: topicFilters,
				confidence: confidenceLevel,
			}),
			onLogTrigger,
		),
		handler(
			httpCapability.trigger(config.httpTrigger || {}),
			onHttpTrigger,
		),
	]
}

/**
 * HTTP Trigger Handler
 * Validates the provided attestation hash matches the on-chain record for the given proofId,
 * then runs the verification workflow.
 */
const onHttpTrigger = async (runtime: Runtime<Config>, payload: HTTPPayload): Promise<string> => {
	try {
		runtime.log('Running HTTP Trigger for verification')

		const inputData = decodeJson(payload.input) as {
			proofId?: string
			attestationHash?: string
		}

		if (!inputData.proofId || !inputData.attestationHash) {
			throw new Error('Missing required fields: proofId and attestationHash')
		}

		const proofId = inputData.proofId as `0x${string}`
		const attestationHash = inputData.attestationHash as `0x${string}`

		runtime.log(`HTTP trigger received proofId: ${proofId}, attestationHash: ${attestationHash}`)

		const network = getNetworkByChainSelector(runtime.config.attestationSetLogTrigger.chainSelectorName)
		if (!network) {
			throw new Error(
				`Network not found for chain selector name: ${runtime.config.attestationSetLogTrigger.chainSelectorName}`
			)
		}

		const evmClient = new EVMClient(network.chainSelector.selector)

		// Call proofIdToLatestAttestation to verify the attestation hash matches on-chain
		runtime.log(`Querying proofIdToLatestAttestation for proofId: ${proofId}`)

		const callData = encodeFunctionData({
			abi: SaveRegistryWithClaim,
			functionName: 'proofIdToLatestAttestation',
			args: [proofId],
		})

		const contractCall = evmClient
			.callContract(runtime, {
				call: encodeCallMsg({
				from: zeroAddress,
				to: runtime.config.attestationSetLogTrigger.address as `0x${string}`,
				data: callData,
				}),
				blockNumber: getBlockNumberByConfidence(runtime.config.verifierProxy.readConfidence),
			})
			.result()

		// Decode the result: (bytes32 attestationHash, address attestor, uint48 timestamp)
		const decoded = decodeFunctionResult({
			abi: SaveRegistryWithClaim,
			functionName: 'proofIdToLatestAttestation',
			data: bytesToHex(contractCall.data),
		}) as readonly [`0x${string}`, `0x${string}`, number]

		const onchainAttestationHash = decoded[0]
		const onchainAttestor = decoded[1]
		const onchainTimestamp = BigInt(decoded[2])

		runtime.log(`Onchain latest attestation: hash=${onchainAttestationHash}, attestor=${onchainAttestor}, timestamp=${onchainTimestamp}`)

		// Verify the provided attestation hash matches the on-chain record
		if (onchainAttestationHash.toLowerCase() !== attestationHash.toLowerCase()) {
			throw new Error(
				`Attestation hash mismatch: provided=${attestationHash}, onchain=${onchainAttestationHash}. ` +
				`The provided attestation hash does not match the latest attestation for proofId ${proofId}.`
			)
		}

		runtime.log('Attestation hash verified against onchain record. Proceeding with verification...')

		// Run the main verification workflow
		const message = await runWorkflow(runtime, proofId, attestationHash)
		runtime.log(`Workflow completed: ${message}`)

		return message
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		const errorStack = error instanceof Error ? error.stack : undefined

		runtime.log(`ERROR in onHttpTrigger: ${errorMessage}`)
		if (errorStack) {
			runtime.log(`Error stack: ${errorStack}`)
		}

		throw error
	}
}

const onLogTrigger = async (runtime: Runtime<Config>, payload: EVMLog): Promise<string> => {
	try {
		runtime.log('Running AttestationSet LogTrigger')

		const topics = payload.topics

		if (topics.length < 3) {
			runtime.log('Log payload does not contain enough topics')
			throw new Error(`log payload does not contain enough topics ${topics.length}`)
		}

		// Extract indexed parameters from topics
		// topics[0]: event signature (AttestationSet)
		// topics[1]: proofId (indexed bytes32)
		const proofId = bytesToHex(topics[1]) as `0x${string}`
		// topics[2]: attestorAddress (indexed address)
		const attestorAddress = bytesToHex(topics[2].slice(12)) // Extract address from 32-byte topic

		runtime.log(`ProofId: ${proofId}, AttestorAddress: ${attestorAddress}`)

		// Decode non-indexed parameters from data
		const decoded = decodeAbiParameters(
			[
				{ name: 'attestationHash', type: 'bytes32' },
				{ name: 'timestamp', type: 'uint48' },
			],
			bytesToHex(payload.data) as `0x${string}`
		)
		const attestationHash = decoded[0]
		const timestamp = decoded[1]
		
		runtime.log(`Attestation Hash: ${attestationHash}, Timestamp: ${timestamp}`)

		const message = await runWorkflow(runtime, proofId, attestationHash)
		runtime.log(`Workflow completed: ${message}`)

		return message
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		const errorStack = error instanceof Error ? error.stack : undefined
		
		runtime.log(`ERROR in onLogTrigger: ${errorMessage}`)
		if (errorStack) {
			runtime.log(`Error stack: ${errorStack}`)
		}
		
		throw error
	}
}

/**
 * Main workflow execution
 */
const runWorkflow = async (
	runtime: Runtime<Config>,
	proofId: string,
	attestationHash: string,
): Promise<string> => {
	try {
		// 1. Retrieve attestation from IPFS

		runtime.log(`Fetching compressed attestation from IPFS using hash ${attestationHash} ...`)
		
		const ipfsCid = hashToIPFSCid(attestationHash)
		runtime.log(`Converted to IPFS CID: ${ipfsCid}`)
		
		const compressedData = runtime.runInNodeMode(
			(nodeRuntime: NodeRuntime<Config>) => fetchFromIpfs(nodeRuntime, ipfsCid),
			consensusIdenticalAggregation<Uint8Array>()
		)().result()

		runtime.log(`Consensus reached on compressed data (${compressedData.length} bytes)`)

		runtime.log('Decompressing attestation data...')
		const attestationData = decompressJson(compressedData)
		if (!attestationData?.metadata || !Array.isArray(attestationData?.claims) || !attestationData?.signature) {
			throw new Error('Invalid attestation data: missing required fields (metadata, claims, signature)')
		}
		runtime.log(`Decompressed successfully.`)

		// 2. Verify attestation using SAVE framework

		runtime.log('Verifying attestation with SAVE ...')

		const verifierPrivateKey = runtime.getSecret({ id: 'verifierprivatekey' }).result().value as `0x${string}`
		const vlayerAuthToken = runtime.getSecret({ id: 'vlayerauthtoken' }).result().value as string

		const now = runtime.now()

		const verificationData: VerificationData = await verifyAttestation(attestationData, {
			verifier: {
				name: runtime.config.verifier.name,
				publicKey: runtime.config.verifier.publicKey as `0x${string}`,
			},
			verifiedAt: now.toISOString(),
			signingKey: verifierPrivateKey,
			httpClient: new CreHttpClient(runtime),
			vlayerCredentials: {
				clientId: runtime.config.vlayerEndpoint.clientId,
				authToken: vlayerAuthToken,
			},
		})

		runtime.log(`Verification status ${verificationData.summary.overallStatus}, total=${verificationData.summary.totalClaims}, valid=${verificationData.summary.validClaims}, invalid=${verificationData.summary.invalidClaims}, uncertain=${verificationData.summary.uncertainClaims}.`)

		// Log errors for failed or uncertain claims
		if (verificationData.errors.length > 0) {
			runtime.log(`\nClaims with issues (${verificationData.errors.length}):`)
			for (const error of verificationData.errors) {
				runtime.log(`  - Claim "${error.claimId}": ${error.status}`)
				if (error.error) {
					runtime.log(`    Error: ${error.error}`)
				}
				// Log evidence type without full content
				if ('pointer' in error.evidence) {
					runtime.log(`    Evidence: Source-backed claim from "${error.evidence.pointer}"`)
				} else if ('aggregationVerified' in error.evidence) {
					runtime.log(`    Evidence: Aggregated claim (verified: ${error.evidence.aggregationVerified})`)
				} else if ('proof' in error.evidence) {
					runtime.log(`    Evidence: Inline claim (proof: ${error.evidence.proof.mechanism})`)
				}
			}
		}

		verificationData.metadata.attestationHash = attestationHash as `0x${string}`

		// 3. Compress verification data

		runtime.log('Compressing verification data...')
		const compressedVerification = compressJson(verificationData)
		runtime.log(`Verification compressed to ${compressedVerification.length} bytes.`)

		// 4. Upload compressed verification to IPFS

		runtime.log('Uploading compressed verification to IPFS...')

		const ipfsUsername = runtime.config.ipfsRpcEndpoint.username
		const ipfsPassword = runtime.getSecret({ id: 'ipfspassword' }).result().value as string

		const verificationCid = runtime.runInNodeMode(
			(nodeRuntime: NodeRuntime<Config>) => pushToIpfs(
				nodeRuntime,
				compressedVerification,
				ipfsUsername,
				ipfsPassword,
				'verification.json.gz',
				'application/gzip'
			),
			consensusIdenticalAggregation<string>()
		)().result()

		runtime.log(`Verification uploaded to IPFS with CID: ${verificationCid}.`)

		// 5. Push verification to on-chain registry

		const verificationHash = ipfsCidToHash(verificationCid)
		runtime.log(`Pushing verification hash ${verificationHash} to onchain registry ...`)

		const network = getNetworkByChainSelector(runtime.config.attestationSetLogTrigger.chainSelectorName)

		if (!network) {
			throw new Error(
				`Network not found for chain selector name: ${runtime.config.attestationSetLogTrigger.chainSelectorName}`
			)
		}

		const evmClient = new EVMClient(network.chainSelector.selector)

		const reportData = encodeFunctionData({
			abi: SaveRegistryWithClaim,
			functionName: 'setVerification',
			args: [
				proofId as `0x${string}`,
				attestationHash as `0x${string}`,
				verificationHash as `0x${string}`
			]
		})
		runtime.log(`Encoded report data: ${reportData}`)

		const reportResponse = runtime
			.report({
				encodedPayload: hexToBase64(reportData),
				encoderName: 'evm',
				signingAlgo: 'ecdsa',
				hashingAlgo: 'keccak256',
			})
			.result()

		runtime.log('Writing report onchain ...')

		const resp = evmClient
			.writeReport(runtime, {
				receiver: runtime.config.verifierProxy.address,
				report: reportResponse,
				gasConfig: {
					gasLimit: runtime.config.verifierProxy.gasLimit,
				},
			})
			.result()

		const txStatus = resp.txStatus

		if (txStatus !== TxStatus.SUCCESS) {
			throw new Error(`Failed to write report: ${resp.errorMessage || txStatus}`)
		}

		const txHash = resp.txHash || new Uint8Array(32)
		runtime.log(`Verification set onchain at txHash ${bytesToHex(txHash)}.`)

		return `Attestation ${attestationHash} verified successfully. Verification CID ${verificationCid}. Verification hash ${verificationHash}`

	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		const errorStack = error instanceof Error ? error.stack : undefined
		
		runtime.log(`ERROR in runWorkflow: ${errorMessage}`)
		if (errorStack) {
			runtime.log(`Error stack: ${errorStack}`)
		}
		
		throw error
	}
}
