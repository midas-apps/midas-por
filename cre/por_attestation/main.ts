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
import { configSchema, type Config, type TokenConfig, getNetworkByChainSelector } from './config.js'
import { CRE_CONFIDENCE_MAP, getBlockNumberByConfidence } from '../library/config-schemas.js'
import { verifyClaimWithVlayer, readOraclePrice, fetchOneTokenReport, fetchSupplyDetails, extractFasanaraNavFromEmail, readOnchainAssets, readOnchainTotalSupply } from './api.js'
import type { OneTokenReportData, OnchainAssetsData, OnchainSupplyData } from './api.js'
import { hashToIPFSCid, ipfsCidToHash } from '../library/utils.js'
import { fetchFromIpfs, pushToIpfsPinata, compressJson, decompressJson } from '../library/ipfs.js'
import { AttestationBuilder } from '@save/core'
import {
	type OpsClaimData,
	createOpsClaimObject,
	createOraclePriceObjectClaim,
	createOraclePriceNumericClaim,
	createInternalOvercollateralizationClaim,
	createExternalOvercollateralizationClaim,
	createOffchainOnchainOvercollateralizationClaim,
	createOvercollateralizationRatioClaim,
	createFundManagerEmailClaim,
	createTotalNavClaim,
	createEmailSenderClaim,
	createEmailReceiverClaim,
	createOneTokenReportClaim,
	createOneTokenNavClaim,
	createOnchainSupplyClaim,
} from './claims.js'

export async function main() {
	try {
		const runner = await Runner.newRunner<Config>({ configSchema: configSchema as any })
		await runner.run(initWorkflow)
	} catch (error) {
		console.error('Fatal error in main:', error)
		throw error
	}
}

const initWorkflow = (config: Config) => {
	const network = getNetworkByChainSelector(config.newClaimLogTrigger.chainSelectorName)

	if (!network) {
		throw new Error(`Network not found: ${config.newClaimLogTrigger.chainSelectorName}`)
	}

	const evmClient = new EVMClient(network.chainSelector.selector)

	// topics[1] is empty — workflow handles all registered tokens
	const topicFilters = config.newClaimLogTrigger.topics.map(topicFilter => ({
		values: topicFilter.values.map(topic => hexToBase64(topic)),
	}))

	const confidenceLevel = CRE_CONFIDENCE_MAP[config.newClaimLogTrigger.confidence]
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
 * Resolve token config by proofId — throws if not registered
 */
function getTokenConfig(runtime: Runtime<Config>, proofId: string): TokenConfig {
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
 * HTTP Trigger Handler — manual attestation
 */
const onHttpTrigger = async (runtime: Runtime<Config>, payload: HTTPPayload): Promise<string> => {
	try {
		runtime.log('Running HTTP Trigger for manual attestation')

		const input = decodeJson(payload.input) as { proofId?: string; claimHash?: string }

		if (!input.proofId || input.proofId === '0x') throw new Error('Missing required field: proofId')
		if (!input.claimHash || input.claimHash === '0x') throw new Error('Missing required field: claimHash')

		const proofId = input.proofId as `0x${string}`
		const claimHash = input.claimHash as `0x${string}`

		// Validate token is registered before doing anything else
		getTokenConfig(runtime, proofId)

		runtime.log(`Received proofId: ${proofId}, claimHash: ${claimHash}`)

		const network = getNetworkByChainSelector(runtime.config.newClaimLogTrigger.chainSelectorName)
		if (!network) throw new Error(`Network not found: ${runtime.config.newClaimLogTrigger.chainSelectorName}`)

		const evmClient = new EVMClient(network.chainSelector.selector)

		const callData = encodeFunctionData({
			abi: SaveRegistryWithClaim,
			functionName: 'getClaimsForProofId',
			args: [proofId],
		})

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

		const claimHashes = decodeFunctionResult({
			abi: SaveRegistryWithClaim,
			functionName: 'getClaimsForProofId',
			data: bytesToHex(contractCall.data),
		}) as `0x${string}`[]

		if (!claimHashes?.length) throw new Error(`No claims found for proofId: ${proofId}`)

		const claimExists = claimHashes.some(h => h.toLowerCase() === claimHash.toLowerCase())
		if (!claimExists) {
			throw new Error(
				`Claim hash ${claimHash} not found for proofId ${proofId}. ` +
				`Available: ${claimHashes.join(', ')}`
			)
		}

		const message = await runWorkflow(runtime, proofId, claimHash)
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
 * EVM Log Trigger Handler — fires on NewClaim with sha256("midas-ops-claim") type
 */
const onLogTrigger = async (runtime: Runtime<Config>, payload: EVMLog): Promise<string> => {
	try {
		runtime.log('Running NewClaim LogTrigger')

		const topics = payload.topics
		if (topics.length < 4) throw new Error(`Not enough topics: ${topics.length}`)

		const proofId = bytesToHex(topics[1]) as `0x${string}`
		const claimProvider = bytesToHex(topics[2].slice(12))
		const claimTypeHash = bytesToHex(topics[3])

		runtime.log(`ProofId: ${proofId}, ClaimProvider: ${claimProvider}, ClaimTypeHash: ${claimTypeHash}`)

		// Skip silently if token not registered — another workflow instance may handle it
		if (!runtime.config.tokens[proofId.toLowerCase()]) {
			runtime.log(`ProofId ${proofId} not registered in this workflow instance — skipping`)
			return `Skipped: proofId ${proofId} not registered`
		}

		const decoded = decodeAbiParameters(
			[
				{ name: 'previousClaimHash', type: 'bytes32' },
				{ name: 'newClaimHash', type: 'bytes32' },
				{ name: 'timestamp', type: 'uint48' },
			],
			bytesToHex(payload.data) as `0x${string}`
		)
		const newClaimHash = decoded[1]
		runtime.log(`NewClaimHash: ${newClaimHash}, Timestamp: ${decoded[2]}`)

		const message = await runWorkflow(runtime, proofId, newClaimHash)
		runtime.log(`Workflow completed: ${message}`)
		return message
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		runtime.log(`ERROR in onLogTrigger: ${msg}`)
		if (error instanceof Error && error.stack) runtime.log(`Stack: ${error.stack}`)
		throw error
	}
}

function formatOneTokenTimestamp(date: Date): string {
	const y = date.getUTCFullYear()
	const m = String(date.getUTCMonth() + 1).padStart(2, '0')
	const d = String(date.getUTCDate()).padStart(2, '0')
	const h = String(date.getUTCHours()).padStart(2, '0')
	return `${y}-${m}-${d}T${h}:00`
}

function computeOneTokenTimestamps(isoDate: string): { exact: string; before: string; after: string } | null {
	try {
		const date = new Date(isoDate)
		if (isNaN(date.getTime())) return null

		const exact = new Date(date)
		exact.setUTCMinutes(0, 0, 0)

		const before = new Date(exact)
		before.setUTCHours(before.getUTCHours() - 1)

		const after = new Date(exact)
		after.setUTCHours(after.getUTCHours() + 1)

		return { exact: formatOneTokenTimestamp(exact), before: formatOneTokenTimestamp(before), after: formatOneTokenTimestamp(after) }
	} catch {
		return null
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
		const tokenConfig = getTokenConfig(runtime, proofId)
		runtime.log(`Processing token: ${tokenConfig.name} (proofId: ${proofId})`)

		// 1. Fetch ops claim from IPFS

		runtime.log(`Fetching ops claim from IPFS: ${newClaimHash}`)
		const ipfsCid = hashToIPFSCid(newClaimHash)

		const compressedData = runtime.runInNodeMode(
			(nodeRuntime: NodeRuntime<Config>) => fetchFromIpfs(nodeRuntime as any, ipfsCid),
			consensusIdenticalAggregation<Uint8Array>()
		)().result()

		const opsClaimData = decompressJson(compressedData) as OpsClaimData

		if (!opsClaimData?.token || !opsClaimData?.totalSupplyCrossChainReportedByOps || !opsClaimData?.navReportedByOps) {
			throw new Error('Invalid ops claim: missing token, totalSupplyCrossChainReportedByOps, or navReportedByOps')
		}

		runtime.log(`Ops claim: token=${opsClaimData.token}, navReportedByOps=${opsClaimData.navReportedByOps}, supply=${opsClaimData.totalSupplyCrossChainReportedByOps}`)

		// 2. Read oracle price on-chain

		runtime.log(`Reading oracle price from ${opsClaimData.oracleAddress} on ${opsClaimData.oracleChainSelectorName}`)

		const oraclePriceData = readOraclePrice(
			runtime,
			opsClaimData.oracleAddress,
			opsClaimData.oracleChainSelectorName,
			8,
		)

		const oraclePriceUSD = Number(oraclePriceData.answer) / Math.pow(10, oraclePriceData.decimals)
		runtime.log(`Oracle price: ${oraclePriceUSD} USD (raw: ${oraclePriceData.answer})`)

		// 2.5. Read on-chain total supply

		let onchainSupplyData: OnchainSupplyData | null = null
		if (tokenConfig.supplyToken) {
			try {
				onchainSupplyData = readOnchainTotalSupply(
					runtime,
					tokenConfig.supplyToken.address,
					tokenConfig.supplyToken.decimals,
					tokenConfig.supplyToken.chainSelectorName,
				)
				runtime.log(`On-chain supply: ${onchainSupplyData.supply.toFixed(6)} tokens (raw: ${onchainSupplyData.supplyRaw})`)
			} catch (e) {
				runtime.log(`WARN: on-chain supply read failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
			}
		}

		// 3. Vlayer fund manager claim (only if hasOffchainData)

		let fundManagerEmailClaim: ReturnType<typeof createFundManagerEmailClaim> | null = null
		let totalNavClaim: ReturnType<typeof createTotalNavClaim> | null = null
		let emailSenderClaim: ReturnType<typeof createEmailSenderClaim> | null = null
		let emailReceiverClaim: ReturnType<typeof createEmailReceiverClaim> | null = null

		const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'
		if (opsClaimData.vlayerClaimHash && opsClaimData.vlayerClaimHash.toLowerCase() !== ZERO_HASH) {

			runtime.log(`Fetching Vlayer claim from IPFS: ${opsClaimData.vlayerClaimHash}`)
			const vlayerCid = hashToIPFSCid(opsClaimData.vlayerClaimHash)

			const vlayerCompressed = runtime.runInNodeMode(
				(nodeRuntime: NodeRuntime<Config>) => fetchFromIpfs(nodeRuntime as any, vlayerCid),
				consensusIdenticalAggregation<Uint8Array>()
			)().result()

			const vlayerClaimData = decompressJson(vlayerCompressed)
			if (!vlayerClaimData?.proof) throw new Error('Invalid Vlayer claim: missing proof')

			runtime.log('Verifying Vlayer fund manager claim...')
			const vlayerResult = await verifyClaimWithVlayer(runtime, vlayerClaimData.proof)
			runtime.log('Vlayer verification successful')

			const fm = tokenConfig.fundManager!
			fundManagerEmailClaim = createFundManagerEmailClaim(vlayerResult, vlayerClaimData.proof)
			try {
				totalNavClaim = createTotalNavClaim(fundManagerEmailClaim, fm.tokenName)
			} catch (e) {
				runtime.log(`WARN: createTotalNavClaim failed (non-fatal, email may not have table format): ${e instanceof Error ? e.message : String(e)}`)
			}
			emailSenderClaim = createEmailSenderClaim(fundManagerEmailClaim, fm.expectedEmail)
			emailReceiverClaim = createEmailReceiverClaim(fundManagerEmailClaim, fm.requiredReceiverEmail, fm.allowedReceiverEmails)
		}

		// Method 1: External overcollateralization
		// Primary: 1token AUM. Fallback within Method 1: Fasanara email + on-chain assets.

		let oneTokenReport: OneTokenReportData | null = null
		let oneTokenRawReport: OneTokenReportData | null = null
		let oneTokenTimestamp: string | null = null

		// Parse Fasanara AUM from Vlayer email (used by offchain-onchain path)
		let fasanaraNavUSD: number | null = null
		if (opsClaimData.vlayerClaimHash && fundManagerEmailClaim) {
			const fasanaraData = extractFasanaraNavFromEmail(fundManagerEmailClaim)
			fasanaraNavUSD = fasanaraData?.fasanaraNavUSD ?? null
			if (fasanaraNavUSD !== null) {
				runtime.log(`Fasanara AUM from email: ${fasanaraNavUSD.toFixed(2)} USD`)
			} else {
				runtime.log('WARN: could not parse Fasanara AUM from email')
			}
		}

		if (tokenConfig.oneTokenApi) {
			try {
				runtime.log('Method 1: trying 1token...')

				const opsSupplyTokens = Number(BigInt(opsClaimData.totalSupplyCrossChainReportedByOps)) / 1e18
				let totalSupplyTokens = opsSupplyTokens
				try {
					const supplyData = fetchSupplyDetails(runtime, tokenConfig.oneTokenApi.tokenName)
					const tsGap = Math.abs(supplyData.timestamp - oraclePriceData.updatedAt)
					if (tsGap <= 3600) {
						totalSupplyTokens = supplyData.supply
						runtime.log(`prices/details supply: ${supplyData.supply.toFixed(6)} tokens (ts gap: ${tsGap}s) ✓`)
					} else {
						runtime.log(`prices/details supply timestamp mismatch (gap: ${tsGap}s > 3600s) — using ops supply: ${opsSupplyTokens.toFixed(6)}`)
					}
				} catch (e) {
					runtime.log(`WARN: prices/details failed, using ops supply: ${e instanceof Error ? e.message : String(e)}`)
				}

				const timestamps = computeOneTokenTimestamps(new Date(oraclePriceData.updatedAt * 1000).toISOString())

				if (timestamps) {
					const opsNavUsed = parseFloat(opsClaimData.navReportedByOps)
					const deviationThreshold = runtime.config.oneTokenDeviationThresholdPercent

					const evaluateReport = (report: OneTokenReportData, ts: string): boolean => {
						const useNavBase = tokenConfig.oneTokenApi!.useNavBase && typeof report.navBase === 'number'
						const oneTokenAUM = useNavBase ? report.navBase! : report.equity.total * 1_000_000
						const navPerToken = totalSupplyTokens > 0 ? oneTokenAUM / totalSupplyTokens : 0
						const ratio = oraclePriceUSD > 0 ? navPerToken / oraclePriceUSD : 0

						const opsDeviation = opsNavUsed > 0
							? Math.abs((oneTokenAUM - opsNavUsed) / opsNavUsed) * 100
							: null
						if (opsDeviation !== null) {
							const flag = opsDeviation > deviationThreshold ? ' ⚠ EXCEEDS THRESHOLD' : ''
							runtime.log(`1token vs ops deviation: ${opsDeviation.toFixed(2)}% (threshold: ${deviationThreshold}%)${flag}`)
						}

						runtime.log(`1token ratio: ${ratio.toFixed(4)} (AUM=${oneTokenAUM.toFixed(0)}, ts=${ts}, threshold: ${runtime.config.overcollateralizationThreshold})`)
						return ratio > runtime.config.overcollateralizationThreshold
					}

					// Try exact timestamp first, then -1h fallback (no after — HTTP call limit = 5)
					for (const ts of [timestamps.exact, timestamps.before]) {
						let report: OneTokenReportData | null = null
						try {
							report = fetchOneTokenReport(runtime, ts, tokenConfig.oneTokenApi)
						} catch (e) {
							runtime.log(`1token "${ts}" error: ${e instanceof Error ? e.message : String(e)}`)
							continue
						}
						if (!report || typeof report.equity?.total !== 'number') {
							runtime.log(`1token "${ts}" no data — trying next`)
							continue
						}
						if (!oneTokenRawReport) {
							oneTokenRawReport = report
							oneTokenTimestamp = ts
						}
						const passed = evaluateReport(report, ts)
						if (passed) {
							oneTokenReport = report
						} else {
							runtime.log('1token ratio below threshold — trying offchain-onchain path')
						}
						break
					}
					if (!oneTokenRawReport) {
						runtime.log('No 1token data found — trying offchain-onchain path')
					}
				}
			} catch (error) {
				runtime.log(`WARN: 1token check failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		// Method 1 fallback: Fasanara email + on-chain assets (mTBILL + USDC)

		let onchainData: OnchainAssetsData | null = null

		if (!oneTokenReport && tokenConfig.onchainAssets) {
			try {
				runtime.log('Method 1 fallback: trying Fasanara + on-chain assets...')
				const totalSupplyTokens = Number(BigInt(opsClaimData.totalSupplyCrossChainReportedByOps)) / 1e18

				const fetchedOnchainData = readOnchainAssets(runtime, tokenConfig.onchainAssets)
				const totalVerifiedAUM = (fasanaraNavUSD ?? 0) + fetchedOnchainData.mtbillValueUSD + fetchedOnchainData.usdcValueUSD
				const navPerToken = totalSupplyTokens > 0 ? totalVerifiedAUM / totalSupplyTokens : 0
				const ratio = oraclePriceUSD > 0 ? navPerToken / oraclePriceUSD : 0
				runtime.log(
					`Offchain-onchain ratio: ${ratio.toFixed(4)} ` +
					`(fasanara=${(fasanaraNavUSD ?? 0).toFixed(2)}, mtbill=${fetchedOnchainData.mtbillValueUSD.toFixed(2)}, usdc=${fetchedOnchainData.usdcValueUSD.toFixed(2)}, threshold: ${runtime.config.overcollateralizationThreshold})`
				)

				if (ratio > runtime.config.overcollateralizationThreshold) {
					onchainData = fetchedOnchainData
				} else {
					runtime.log('Offchain-onchain ratio below threshold — falling back to Method 2')
				}
			} catch (error) {
				runtime.log(`WARN: offchain-onchain check failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		// Method 2: Internal fallback — ops claim NAV

		const totalSupplyTokens = Number(BigInt(opsClaimData.totalSupplyCrossChainReportedByOps)) / 1e18
		const navUsed = parseFloat(opsClaimData.navReportedByOps)
		const internalNavPerToken = totalSupplyTokens > 0 ? navUsed / totalSupplyTokens : 0
		const internalRatio = oraclePriceUSD > 0 ? internalNavPerToken / oraclePriceUSD : 0
		const internalPassed = !oneTokenReport && !onchainData
			? internalRatio > runtime.config.overcollateralizationThreshold
			: false

		if (!oneTokenReport && !onchainData) {
			runtime.log(`Method 2 (internal) ratio: ${internalRatio.toFixed(4)} (passed: ${internalPassed})`)
		}

		// Determine overcollateralization type

		let overcollateralizationType: string
		if (oneTokenReport) {
			overcollateralizationType = 'external-data'
		} else if (onchainData) {
			overcollateralizationType = 'offchain-onchain-data'
		} else if (internalPassed) {
			overcollateralizationType = 'internal-data'
		} else {
			throw new Error(
				`Overcollateralization check failed for ${tokenConfig.name}. ` +
				`Method 1 (1token): unavailable or failed. ` +
				`Method 1 fallback (offchain-onchain): ${tokenConfig.onchainAssets ? 'failed' : 'not configured'}. ` +
				`Method 2 (internal): ratio=${internalRatio.toFixed(4)}, threshold=${runtime.config.overcollateralizationThreshold}. ` +
				`Attestation will not be pushed.`
			)
		}

		runtime.log(`Overcollateralization: type=${overcollateralizationType}`)

		// 7. Build claims

		const opsClaimObject = createOpsClaimObject(opsClaimData)
		const oraclePriceObjectClaim = createOraclePriceObjectClaim(
			opsClaimData.oracleAddress,
			opsClaimData.oracleChainSelectorName,
			oraclePriceData,
		)
		const oraclePriceNumericClaim = createOraclePriceNumericClaim()
		const overcollateralizationClaim = oneTokenReport
			? createExternalOvercollateralizationClaim(
				oneTokenReport.equity.total,
				opsClaimData,
				oraclePriceData,
				runtime.config.overcollateralizationThreshold,
			)
			: onchainData
			? createOffchainOnchainOvercollateralizationClaim(
				onchainData,
				fasanaraNavUSD ?? 0,
				opsClaimData,
				oraclePriceData,
				runtime.config.overcollateralizationThreshold,
			)
			: createInternalOvercollateralizationClaim(
				opsClaimData,
				oraclePriceData,
				runtime.config.overcollateralizationThreshold,
			)

		// 8. Build and sign attestation

		const attesterPrivateKey = runtime.getSecret({ id: 'attesterprivatekey' }).result().value as `0x${string}`
		const attesterPublicKey = runtime.config.attester.publicKey as `0x${string}`
		const now = runtime.now()

		const attestationBuilder = new AttestationBuilder({
			issuer: { identity: attesterPublicKey, name: 'Midas' },
			publicKeySource: 'https://midas.xyz/.well-known/save-keys.json',
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
			proofId,
		})
			.addClaim(opsClaimObject)
			.addClaim(oraclePriceObjectClaim)
			.addClaim(oraclePriceNumericClaim)
			.addClaim(overcollateralizationClaim)
			.addClaim(createOvercollateralizationRatioClaim())

		if (fundManagerEmailClaim && totalNavClaim && emailSenderClaim && emailReceiverClaim) {
			attestationBuilder
				.addClaim(fundManagerEmailClaim)
				.addClaim(totalNavClaim)
				.addClaim(emailSenderClaim)
				.addClaim(emailReceiverClaim)
			runtime.log('Vlayer fund manager claims added')
		}

		if (oneTokenRawReport && oneTokenTimestamp) {
			attestationBuilder
				.addClaim(createOneTokenReportClaim(oneTokenRawReport, tokenConfig.name, oneTokenTimestamp))
				.addClaim(createOneTokenNavClaim(tokenConfig.name))
			runtime.log(`1token claims added (overcol passed: ${!!oneTokenReport})`)
		}

		if (onchainSupplyData && tokenConfig.supplyToken) {
			attestationBuilder.addClaim(createOnchainSupplyClaim(
				tokenConfig.supplyToken.address,
				tokenConfig.supplyToken.chainSelectorName,
				onchainSupplyData,
				now.toISOString(),
			))
			runtime.log('On-chain supply claim added')
		}

		const attestation = attestationBuilder.sign(attesterPrivateKey)
		runtime.log(`Attestation signed, ID: ${attestation.id}`)

		// 9. Compress + upload to IPFS

		const compressedAttestation = compressJson(attestation.toData())
		runtime.log(`Compressed to ${compressedAttestation.length} bytes`)

		const pinataJwt = runtime.getSecret({ id: 'pinatajwt' }).result().value as string
		const pinataGroupId = runtime.getSecret({ id: 'attestationpinatagroupid' }).result().value as string | undefined

		const attestationCid = runtime.runInNodeMode(
			(nodeRuntime: NodeRuntime<Config>) => pushToIpfsPinata(
				nodeRuntime,
				compressedAttestation,
				pinataJwt,
				`attestation_${tokenConfig.name}_${now.toISOString().slice(0, 10)}.json.gz`,
				'application/gzip',
				pinataGroupId || undefined,
			),
			consensusIdenticalAggregation<string>()
		)().result()

		runtime.log(`Attestation uploaded: ${attestationCid}`)

		// 10. Push attestation hash on-chain

		const attestationHash = ipfsCidToHash(attestationCid)
		const network = getNetworkByChainSelector(runtime.config.newClaimLogTrigger.chainSelectorName)
		if (!network) throw new Error(`Network not found: ${runtime.config.newClaimLogTrigger.chainSelectorName}`)

		const evmClient = new EVMClient(network.chainSelector.selector)

		const reportData = encodeFunctionData({
			abi: SaveRegistryWithClaim,
			functionName: 'setAttestation',
			args: [proofId as `0x${string}`, attestationHash as `0x${string}`],
		})

		const reportResponse = runtime.report({
			encodedPayload: hexToBase64(reportData),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		}).result()

		const resp = evmClient.writeReport(runtime, {
			receiver: runtime.config.attesterProxy.address,
			report: reportResponse,
			gasConfig: { gasLimit: runtime.config.attesterProxy.gasLimit },
		}).result()

		if (resp.txStatus !== TxStatus.SUCCESS) {
			throw new Error(`Failed to write report: ${resp.errorMessage || resp.txStatus}`)
		}

		const txHash = bytesToHex(resp.txHash || new Uint8Array(32))
		runtime.log(`Attestation set on-chain: ${txHash}`)

		return (
			`${tokenConfig.name} claim ${newClaimHash} processed. ` +
			`Overcollateralization: ${overcollateralizationType}. ` +
			`Attestation CID: ${attestationCid}. TxHash: ${txHash}`
		)

	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		runtime.log(`ERROR in runWorkflow: ${msg}`)
		if (error instanceof Error && error.stack) runtime.log(`Stack: ${error.stack}`)
		throw error
	}
}
