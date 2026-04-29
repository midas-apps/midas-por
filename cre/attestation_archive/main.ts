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
	encodeCallMsg,
	decodeJson,
} from '@chainlink/cre-sdk'
import { decodeAbiParameters, encodeFunctionData, decodeFunctionResult, zeroAddress } from 'viem'
import { SaveRegistryWithClaim } from '../contracts/abi/SaveRegistryWithClaim.js'
import { configSchema, type Config, getNetworkByChainSelector } from './config.js'
import { CRE_CONFIDENCE_MAP, getBlockNumberByConfidence } from '../library/config-schemas.js'
import { verifyClaimWithVlayer } from './api.js'
import { hashToIPFSCid, ipfsCidToHash } from '../library/utils.js'
import { fetchFromIpfs, pushToIpfs, compressJson, decompressJson } from '../library/ipfs.js'
import { AttestationBuilder } from '@save/core'
import { 
	createFundManagerEmailClaim,
	createTotalNavClaim,
	createEmailSenderClaim,
	createEmailReceiverClaim,
} from './claims.js'

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
	const network = getNetworkByChainSelector(config.newClaimLogTrigger.chainSelectorName)
	
	if (!network) {
		throw new Error(
			`Network not found for chain selector name: ${config.newClaimLogTrigger.chainSelectorName}`
		)
	}

	const evmClient = new EVMClient(network.chainSelector.selector)

	// Convert hex topics to base64 as required by CRE
	const topicFilters = config.newClaimLogTrigger.topics.map(topicFilter => ({
		values: topicFilter.values.map(topic => hexToBase64(topic))
	}))

	// Map confidence level to CRE format
	const confidenceLevel = CRE_CONFIDENCE_MAP[config.newClaimLogTrigger.confidence]

	// HTTP trigger for manual attestation creation
	const httpCapability = new HTTPCapability()

	return [
		handler(
			evmClient.logTrigger({
				addresses: [hexToBase64(config.newClaimLogTrigger.address)],
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
 * Validates the provided claim hash exists for the given proofId and creates an attestation
 */
const onHttpTrigger = async (runtime: Runtime<Config>, payload: HTTPPayload): Promise<string> => {
	try {
		runtime.log('Running HTTP Trigger for manual attestation creation')

		// Parse the input JSON to get proofId and claimHash
		const input = decodeJson(payload.input) as { proofId?: string; claimHash?: string }

		if (!input.proofId || input.proofId === '0x') {
			throw new Error('Missing required field: proofId')
		}

		if (!input.claimHash || input.claimHash === '0x') {
			throw new Error('Missing required field: claimHash')
		}

		const proofId = input.proofId as `0x${string}`
		const claimHash = input.claimHash as `0x${string}`
		runtime.log(`Received proofId: ${proofId}, claimHash: ${claimHash}`)

		// Verify the claim hash exists in the registry for this proofId
		const network = getNetworkByChainSelector(runtime.config.newClaimLogTrigger.chainSelectorName)

		if (!network) {
			throw new Error(
				`Network not found for chain selector name: ${runtime.config.newClaimLogTrigger.chainSelectorName}`
			)
		}

		const evmClient = new EVMClient(network.chainSelector.selector)

		runtime.log('Fetching claim hashes from registry for verification...')

		// Encode the contract call to getClaimsForProofId
		const callData = encodeFunctionData({
			abi: SaveRegistryWithClaim,
			functionName: 'getClaimsForProofId',
			args: [proofId],
		})

		// Call the registry contract
		const contractCall = evmClient
			.callContract(runtime, {
				call: encodeCallMsg({
					from: zeroAddress,
					to: runtime.config.newClaimLogTrigger.address as `0x${string}`,
					data: callData,
				}),
				blockNumber: getBlockNumberByConfidence(runtime.config.attesterProxy.readConfidence),
			})
			.result()

		// Decode the result to get the array of claim hashes
		const claimHashes = decodeFunctionResult({
			abi: SaveRegistryWithClaim,
			functionName: 'getClaimsForProofId',
			data: bytesToHex(contractCall.data),
		}) as `0x${string}`[]

		if (!claimHashes || claimHashes.length === 0) {
			throw new Error(`No claims found for proofId: ${proofId}`)
		}

		// Verify the provided claim hash exists in the registry
		const claimHashLower = claimHash.toLowerCase()
		const claimExists = claimHashes.some(hash => hash.toLowerCase() === claimHashLower)

		if (!claimExists) {
			throw new Error(
				`Claim hash ${claimHash} not found in registry for proofId ${proofId}. ` +
				`Available claims: ${claimHashes.join(', ')}`
			)
		}

		runtime.log(`Claim hash verified: ${claimHash}`)

		// Run the attestation workflow with the verified claim hash
		const message = await runWorkflow(runtime, proofId, claimHash)
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

/**
 * EVM Log Trigger Handler
 * Triggered when a NewClaim event is emitted
 */
const onLogTrigger = async (runtime: Runtime<Config>, payload: EVMLog): Promise<string> => {
	try {
		runtime.log('Running NewClaim LogTrigger')

		const topics = payload.topics

		if (topics.length < 4) {
			runtime.log('Log payload does not contain enough topics')
			throw new Error(`log payload does not contain enough topics ${topics.length}`)
		}

		// Extract indexed parameters from topics
		// topics[0]: event signature (NewClaim)
		// topics[1]: proofId (indexed bytes32)
		const proofId = bytesToHex(topics[1]) as `0x${string}`
		//const proofId: `0x${string}` = "0xF48C6AA836CA46212DB9E3E5DD84477ACAA035D3FD76F02B3B466E739BB6EF4E"
		// topics[2]: claimProvider (indexed address)
		const claimProvider = bytesToHex(topics[2].slice(12)) // Extract address from 32-byte topic
		// topics[3]: claimType (indexed string - keccak256 hash)
		const claimTypeHash = bytesToHex(topics[3])

		runtime.log(`ProofId: ${proofId}, ClaimProvider: ${claimProvider}, ClaimType Hash: ${claimTypeHash}`)

		// Decode non-indexed parameters from data (if present)
		// Check if data field is empty (all parameters might be indexed)
		let previousClaimHash: `0x${string}` | undefined
		let newClaimHash: `0x${string}` | undefined
		let timestamp: bigint | number | undefined

		const decoded = decodeAbiParameters(
			[
				{ name: 'previousClaimHash', type: 'bytes32' },
				{ name: 'newClaimHash', type: 'bytes32' },
				{ name: 'timestamp', type: 'uint48' },
			],
			bytesToHex(payload.data) as `0x${string}`
		)
		previousClaimHash = decoded[0]
		newClaimHash = decoded[1]
		timestamp = decoded[2]
		runtime.log(`New Claim Hash: ${newClaimHash}, Previous Claim Hash: ${previousClaimHash}, Timestamp: ${timestamp}`)

		const message = await runWorkflow(runtime, proofId, newClaimHash)
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
	newClaimHash: string,
): Promise<string> => {
	try {
		// 1. Retrieve claim data from IPFS

		runtime.log(`Fetching compressed claim data from IPFS using hash: ${newClaimHash}`)
		
		const ipfsCid = hashToIPFSCid(newClaimHash)
		runtime.log(`Converted to IPFS CID: ${ipfsCid}`)
		
		// Fetch compressed data with simple identical consensus
		const compressedData = runtime.runInNodeMode(
			(nodeRuntime: NodeRuntime<Config>) => fetchFromIpfs(nodeRuntime, ipfsCid),
			consensusIdenticalAggregation<Uint8Array>()
		)().result()

		runtime.log(`Consensus reached on compressed data (${compressedData.length} bytes)`)

		// Decompress data locally (after consensus)
		runtime.log('Decompressing claim data...')
		const claimData = decompressJson(compressedData)
		runtime.log(`Decompressed successfully`)

		if (!claimData || !claimData.proof) {
			throw new Error('Invalid claim data: missing proof object')
		}

		// 2. Verify claim using vlayer web proof verification

		runtime.log('Verifying claim with vlayer...')
		const vlayerVerificationResult = await verifyClaimWithVlayer(runtime, claimData.proof)
		runtime.log('Vlayer verification successful')

		// 3. Create claims from verified data

		runtime.log('Creating fund manager email object claim...')
		const fundManagerEmailClaim = createFundManagerEmailClaim(
			runtime,
			vlayerVerificationResult,
			claimData.proof
		)

		runtime.log('Creating Total NAV source-backed claim from fund manager email object claim')
		const totalNavClaim = createTotalNavClaim(runtime, fundManagerEmailClaim)

		runtime.log(`Creating email sender source-backed claim (expected: ${runtime.config.fundManager.expectedEmail})`)
		const emailSenderClaim = createEmailSenderClaim(
			runtime,
			fundManagerEmailClaim,
			runtime.config.fundManager.expectedEmail
		)

		const { requiredReceiverEmail, allowedReceiverEmails } = runtime.config.fundManager
		runtime.log(`Creating email receiver source-backed claim (required: ${requiredReceiverEmail}, allowed: ${[requiredReceiverEmail, ...allowedReceiverEmails].join(', ')})`)
		const emailReceiverClaim = createEmailReceiverClaim(
			runtime,
			fundManagerEmailClaim,
			requiredReceiverEmail,
			allowedReceiverEmails
		)

		// 4. Create and sign attestation

		runtime.log('Creating attestation...')

		const attesterPrivateKey = runtime.getSecret({ id: 'attesterprivatekey' }).result().value as `0x${string}`
		const attesterPublicKey = runtime.config.attester.publicKey as `0x${string}`

		const now = runtime.now()
		const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

		const attestationBuilder = new AttestationBuilder({
			issuer: {
				identity: attesterPublicKey,
				name: 'Midas',
			},
			publicKeySource: 'https://midas.xyz/.well-known/save-keys.json',
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(), // 7 days from DON time
			proofId: proofId,
		})
			.addClaim(fundManagerEmailClaim)
			.addClaim(totalNavClaim)
			.addClaim(emailSenderClaim)
			.addClaim(emailReceiverClaim)

		runtime.log('Attestation created.')

		runtime.log('Signing attestation...')
		const attestation = attestationBuilder.sign(attesterPrivateKey)

		const attestationData = attestation.toData()
		runtime.log(`Attestation signed with attester public key ${attesterPublicKey}, ID: ${attestation.id}`)

		// 5. Compress attestation data
		
		runtime.log('Compressing attestation data...')
		const compressedAttestation = compressJson(attestationData)
		runtime.log(`Attestation compressed to ${compressedAttestation.length} bytes`)

		// 6. Upload compressed attestation to IPFS

		runtime.log('Uploading compressed attestation to IPFS...')
		
		const ipfsUsername = runtime.config.ipfsRpcEndpoint.username
		const ipfsPassword = runtime.getSecret({ id: 'ipfspassword' }).result().value as string
		
		const attestationCid = runtime.runInNodeMode(
			(nodeRuntime: NodeRuntime<Config>) => pushToIpfs(
				nodeRuntime,
				compressedAttestation,
				ipfsUsername,
				ipfsPassword,
				'attestation.json.gz',
				'application/gzip'
			),
			consensusIdenticalAggregation<string>()
		)().result()

		runtime.log(`Attestation uploaded to IPFS with CID: ${attestationCid}`)

		// 7. Push attestation to on-chain registry

		const attestationHash = ipfsCidToHash(attestationCid)
		runtime.log(`Pushing attestation hash ${attestationHash} to on-chain registry...`)
		
		const network = getNetworkByChainSelector(runtime.config.newClaimLogTrigger.chainSelectorName)
		
		if (!network) {
			throw new Error(
				`Network not found for chain selector name: ${runtime.config.newClaimLogTrigger.chainSelectorName}`
			)
		}

		const evmClient = new EVMClient(network.chainSelector.selector)

		const reportData = encodeFunctionData({
			abi: SaveRegistryWithClaim,
			functionName: 'setAttestation',
			args: [proofId as `0x${string}`, attestationHash as `0x${string}`]
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

		runtime.log('Writing report onchain...')

		const resp = evmClient
			.writeReport(runtime, {
				receiver: runtime.config.attesterProxy.address,
				report: reportResponse,
				gasConfig: {
					gasLimit: runtime.config.attesterProxy.gasLimit,
				},
			})
			.result()

		const txStatus = resp.txStatus

		if (txStatus !== TxStatus.SUCCESS) {
			throw new Error(`Failed to write report: ${resp.errorMessage || txStatus}`)
		}

		const txHash = resp.txHash || new Uint8Array(32)
		runtime.log(`Attestation set onchain at txHash: ${bytesToHex(txHash)}`)

		return `Claim ${newClaimHash} processed successfully. Attestation CID: ${attestationCid}, TxHash: ${bytesToHex(txHash)}`
		
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
