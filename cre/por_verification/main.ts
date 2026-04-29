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
import { configSchema, type Config, type TokenVerificationConfig } from './config.js'
import { hashToIPFSCid, ipfsCidToHash, stringToBase64 } from '../library/utils.js'
import { verifyAttestation } from '@save/core'
import type { VerificationData, HttpClient, HttpResponse } from '@save/core'
import { fetchFromIpfs, pushToIpfs, pushToIpfsPinata, compressJson, decompressJson } from '../library/ipfs.js'
import { getNetworkByChainSelector, CRE_CONFIDENCE_MAP, getBlockNumberByConfidence } from '../library/config-schemas.js'
import { SaveRegistryWithClaim } from '../contracts/abi/SaveRegistryWithClaim.js'

/**
 * HttpClient adapter for @save/core using CRE's HTTPClient with DON consensus.
 */
class CreHttpClient implements HttpClient {
	constructor(private runtime: Runtime<Config>) {}

	async post(url: string, body: string, headers: Record<string, string>): Promise<HttpResponse> {
		return this.runtime.runInNodeMode(
			(nodeRuntime: NodeRuntime<Config>) => {
				const httpClient = new HTTPClient()
				const response = httpClient.sendRequest(nodeRuntime, {
					url,
					method: 'POST' as const,
					headers,
					body: stringToBase64(body),
					timeout: '10s',
					cacheSettings: { store: true, maxAge: '30s' },
				}).result()
				return {
					status: response.statusCode,
					body: new TextDecoder().decode(response.body),
				}
			},
			consensusIdenticalAggregation<HttpResponse>()
		)().result()
	}
}

export async function main() {
	try {
		const runner = await Runner.newRunner<Config>({ configSchema })
		await runner.run(initWorkflow)
	} catch (error) {
		console.error('Fatal error in main:', error)
		throw error
	}
}

const initWorkflow = (config: Config) => {
	const network = getNetworkByChainSelector(config.attestationSetLogTrigger.chainSelectorName)

	if (!network) {
		throw new Error(`Network not found: ${config.attestationSetLogTrigger.chainSelectorName}`)
	}

	const evmClient = new EVMClient(network.chainSelector.selector)

	// topics[1] is empty — workflow handles all registered tokens
	const topicFilters = config.attestationSetLogTrigger.topics.map((topicFilter: any) => ({
		values: topicFilter.values.map((topic: string) => hexToBase64(topic)),
	}))

	const confidenceLevel = CRE_CONFIDENCE_MAP[config.attestationSetLogTrigger.confidence]
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
 * Resolve token config by proofId — throws if not registered
 */
function getTokenConfig(runtime: Runtime<Config>, proofId: string): TokenVerificationConfig {
	const tokenConfig = runtime.config.tokens[proofId.toLowerCase()]
	if (!tokenConfig) {
		throw new Error(
			`ProofId ${proofId} is not registered in this workflow. ` +
			`Registered tokens: ${Object.keys(runtime.config.tokens).map(k => runtime.config.tokens[k].name).join(', ')}`
		)
	}
	return tokenConfig
}

/**
 * HTTP Trigger Handler — manual verification
 */
const onHttpTrigger = async (runtime: Runtime<Config>, payload: HTTPPayload): Promise<string> => {
	try {
		runtime.log('Running HTTP Trigger for manual verification')

		const input = decodeJson(payload.input) as { proofId?: string; attestationHash?: string }

		if (!input.proofId || !input.attestationHash) {
			throw new Error('Missing required fields: proofId and attestationHash')
		}

		const proofId = input.proofId as `0x${string}`
		const attestationHash = input.attestationHash as `0x${string}`

		getTokenConfig(runtime, proofId)

		runtime.log(`Received proofId: ${proofId}, attestationHash: ${attestationHash}`)

		const network = getNetworkByChainSelector(runtime.config.attestationSetLogTrigger.chainSelectorName)
		if (!network) throw new Error(`Network not found: ${runtime.config.attestationSetLogTrigger.chainSelectorName}`)

		const evmClient = new EVMClient(network.chainSelector.selector)

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

		const decoded = decodeFunctionResult({
			abi: SaveRegistryWithClaim,
			functionName: 'proofIdToLatestAttestation',
			data: bytesToHex(contractCall.data),
		}) as readonly [`0x${string}`, `0x${string}`, number]

		const onchainHash = decoded[0]
		runtime.log(`On-chain attestation hash: ${onchainHash}`)

		if (onchainHash.toLowerCase() !== attestationHash.toLowerCase()) {
			throw new Error(`Hash mismatch: provided=${attestationHash}, onchain=${onchainHash}`)
		}

		const message = await runWorkflow(runtime, proofId, attestationHash)
		runtime.log(`Workflow completed: ${message}`)
		return message
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		runtime.log(`ERROR in onHttpTrigger: ${msg}`)
		if (error instanceof Error && error.stack) runtime.log(`Stack: ${error.stack}`)
		throw error
	}
}

/**
 * EVM Log Trigger Handler — fires on AttestationSet event
 */
const onLogTrigger = async (runtime: Runtime<Config>, payload: EVMLog): Promise<string> => {
	try {
		runtime.log('Running AttestationSet LogTrigger')

		const topics = payload.topics
		if (topics.length < 3) throw new Error(`Not enough topics: ${topics.length}`)

		const proofId = bytesToHex(topics[1]) as `0x${string}`
		const attestorAddress = bytesToHex(topics[2].slice(12))

		runtime.log(`ProofId: ${proofId}, AttestorAddress: ${attestorAddress}`)

		// Skip silently if token not registered
		if (!runtime.config.tokens[proofId.toLowerCase()]) {
			runtime.log(`ProofId ${proofId} not registered in this workflow instance — skipping`)
			return `Skipped: proofId ${proofId} not registered`
		}

		const decoded = decodeAbiParameters(
			[
				{ name: 'attestationHash', type: 'bytes32' },
				{ name: 'timestamp', type: 'uint48' },
			],
			bytesToHex(payload.data) as `0x${string}`
		)
		const attestationHash = decoded[0]
		runtime.log(`AttestationHash: ${attestationHash}, Timestamp: ${decoded[1]}`)

		const message = await runWorkflow(runtime, proofId, attestationHash)
		runtime.log(`Workflow completed: ${message}`)
		return message
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		runtime.log(`ERROR in onLogTrigger: ${msg}`)
		if (error instanceof Error && error.stack) runtime.log(`Stack: ${error.stack}`)
		throw error
	}
}

/**
 * Main verification workflow
 */
const runWorkflow = async (
	runtime: Runtime<Config>,
	proofId: string,
	attestationHash: string,
): Promise<string> => {
	try {
		const tokenConfig = getTokenConfig(runtime, proofId)
		runtime.log(`Verifying attestation for ${tokenConfig.name} (proofId: ${proofId})`)

		// 1. Fetch attestation from IPFS

		runtime.log(`Fetching attestation from IPFS: ${attestationHash}`)
		const ipfsCid = hashToIPFSCid(attestationHash)

		const compressedData = runtime.runInNodeMode(
			(nodeRuntime: NodeRuntime<Config>) => fetchFromIpfs(nodeRuntime, ipfsCid),
			consensusIdenticalAggregation<Uint8Array>()
		)().result()

		const attestationData = decompressJson(compressedData)

		if (!attestationData?.metadata || !Array.isArray(attestationData?.claims) || !attestationData?.signature) {
			throw new Error('Invalid attestation data: missing metadata, claims, or signature')
		}

		runtime.log('Attestation decompressed successfully')

		// 2. Verify attestation using SAVE framework

		runtime.log('Verifying attestation with SAVE...')

		const verifierPrivateKey = runtime.getSecret({ id: 'verifierprivatekey' }).result().value as `0x${string}`
		const now = runtime.now()

		const verificationOptions: Parameters<typeof verifyAttestation>[1] = {
			verifier: {
				name: runtime.config.verifier.name,
				publicKey: runtime.config.verifier.publicKey as `0x${string}`,
			},
			verifiedAt: now.toISOString(),
			signingKey: verifierPrivateKey,
			httpClient: new CreHttpClient(runtime),
		}

		// Vlayer credentials only needed for tokens with off-chain data
		if (tokenConfig.hasOffchainData && tokenConfig.vlayerEndpoint) {
			const vlayerAuthToken = runtime.getSecret({ id: 'vlayerauthtoken' }).result().value as string
			verificationOptions.vlayerCredentials = {
				clientId: tokenConfig.vlayerEndpoint.clientId,
				authToken: vlayerAuthToken,
			}
		}

		const verificationData: VerificationData = await verifyAttestation(attestationData, verificationOptions)

		runtime.log(
			`Verification: ${verificationData.summary.overallStatus} — ` +
			`total=${verificationData.summary.totalClaims}, ` +
			`valid=${verificationData.summary.validClaims}, ` +
			`invalid=${verificationData.summary.invalidClaims}, ` +
			`uncertain=${verificationData.summary.uncertainClaims}`
		)

		if (verificationData.errors.length > 0) {
			for (const err of verificationData.errors) {
				runtime.log(`  Claim "${err.claimId}": ${err.status}${err.error ? ` — ${err.error}` : ''}`)
			}
		}

		if (verificationData.summary.overallStatus !== 'Valid') {
			runtime.log(`Verification failed — skipping IPFS upload and on-chain push`)
			return (
				`Attestation ${attestationHash} verification failed: ${verificationData.summary.overallStatus}. ` +
				`valid=${verificationData.summary.validClaims}/${verificationData.summary.totalClaims}`
			)
		}


		verificationData.metadata.attestationHash = attestationHash as `0x${string}`

		// 3. Compress + upload verification to IPFS

		const compressedVerification = compressJson(verificationData)
		runtime.log(`Verification compressed to ${compressedVerification.length} bytes`)

		let verificationCid: string

		if (runtime.config.ipfsPinataEndpoint) {
			// Pinata upload (Midas verifiers)
			const pinataJwt = runtime.getSecret({ id: 'pinatajwt' }).result().value as string
			const pinataGroupId = runtime.getSecret({ id: 'verificationpinatagroupid' }).result().value as string | undefined
			verificationCid = runtime.runInNodeMode(
				(nodeRuntime: NodeRuntime<Config>) => pushToIpfsPinata(
					nodeRuntime as any,
					compressedVerification,
					pinataJwt,
					`verification_${tokenConfig.name}_${now.toISOString().slice(0, 10)}.json.gz`,
					'application/gzip',
					pinataGroupId || undefined,
				),
				consensusIdenticalAggregation<string>()
			)().result()
		} else {
			// Kubo upload (LlamaRisk verifiers)
			const ipfsUsername = runtime.config.ipfsRpcEndpoint!.username
			const ipfsPassword = runtime.getSecret({ id: 'ipfspassword' }).result().value as string
			verificationCid = runtime.runInNodeMode(
				(nodeRuntime: NodeRuntime<Config>) => pushToIpfs(
					nodeRuntime,
					compressedVerification,
					ipfsUsername,
					ipfsPassword,
					`verification_${tokenConfig.name}_${now.toISOString().slice(0, 10)}.json.gz`,
					'application/gzip'
				),
				consensusIdenticalAggregation<string>()
			)().result()
		}

		runtime.log(`Verification uploaded: ${verificationCid}`)

		// 4. Push verification hash on-chain

		const verificationHash = ipfsCidToHash(verificationCid)
		const network = getNetworkByChainSelector(runtime.config.attestationSetLogTrigger.chainSelectorName)
		if (!network) throw new Error(`Network not found: ${runtime.config.attestationSetLogTrigger.chainSelectorName}`)

		const evmClient = new EVMClient(network.chainSelector.selector)

		const reportData = encodeFunctionData({
			abi: SaveRegistryWithClaim,
			functionName: 'setVerification',
			args: [
				proofId as `0x${string}`,
				attestationHash as `0x${string}`,
				verificationHash as `0x${string}`,
			],
		})

		const reportResponse = runtime.report({
			encodedPayload: hexToBase64(reportData),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		}).result()

		const resp = evmClient.writeReport(runtime, {
			receiver: runtime.config.verifierProxy.address,
			report: reportResponse,
			gasConfig: { gasLimit: runtime.config.verifierProxy.gasLimit },
		}).result()

		if (resp.txStatus !== TxStatus.SUCCESS) {
			throw new Error(`Failed to write report: ${resp.errorMessage || resp.txStatus}`)
		}

		const txHash = bytesToHex(resp.txHash || new Uint8Array(32))
		runtime.log(`Verification set on-chain: ${txHash}`)

		return (
			`${tokenConfig.name} attestation ${attestationHash} verified. ` +
			`Verification CID: ${verificationCid}. TxHash: ${txHash}`
		)

	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		runtime.log(`ERROR in runWorkflow: ${msg}`)
		if (error instanceof Error && error.stack) runtime.log(`Stack: ${error.stack}`)
		throw error
	}
}
