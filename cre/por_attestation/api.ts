import {
	consensusIdenticalAggregation,
	HTTPClient,
	Runtime,
	type NodeRuntime,
	EVMClient,
	encodeCallMsg,
	bytesToHex,
	LATEST_BLOCK_NUMBER,
} from '@chainlink/cre-sdk'
import { encodeFunctionData, decodeFunctionResult, zeroAddress } from 'viem'
import type { Config, OnchainAssetsConfig } from './config.js'
import { stringToBase64 } from '../library/utils.js'
import { getNetworkByChainSelector } from '../library/config-schemas.js'

/**
 * Vlayer verification result - raw response from vlayer API
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

interface VlayerVerificationResultConsensus {
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

function verifyClaimWithVlayerInternal(
	nodeRuntime: NodeRuntime<Config>,
	proof: { data: string; version: string; meta: { notaryUrl: string } },
	vlayerUrl: string,
	clientId: string,
	authToken: string
): VlayerVerificationResultConsensus {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (clientId) headers['x-client-id'] = clientId
	if (authToken) headers['Authorization'] = `Bearer ${authToken}`

	const httpClient = new HTTPClient()
	const body = stringToBase64(JSON.stringify(proof))

	const response = httpClient.sendRequest(nodeRuntime, {
		url: vlayerUrl,
		method: 'POST' as const,
		headers,
		body,
		timeout: '10s',
		cacheSettings: { store: true, maxAge: '30s' },
	}).result()

	if (response.statusCode !== 200) {
		const errorBody = new TextDecoder().decode(response.body)
		throw new Error(`vlayer verification failed with status ${response.statusCode}: ${errorBody}`)
	}

	const fullResponse = JSON.parse(new TextDecoder().decode(response.body))

	return {
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
}

const VLAYER_URL = 'https://web-prover.vlayer.xyz/api/v1/verify'
const VLAYER_CLIENT_ID = '3fa54803-7047-41af-bf4b-0e73db72ae63'

/**
 * Verify Vlayer claim with DON consensus.
 */
export async function verifyClaimWithVlayer(
	runtime: Runtime<Config>,
	proofData: any,
): Promise<VlayerVerificationResult> {
	const authToken = runtime.getSecret({ id: 'vlayerauthtoken' }).result().value as string

	const consensus = runtime.runInNodeMode(
		(nodeRuntime: NodeRuntime<Config>) => verifyClaimWithVlayerInternal(
			nodeRuntime,
			proofData,
			VLAYER_URL,
			VLAYER_CLIENT_ID,
			authToken
		),
		consensusIdenticalAggregation<VlayerVerificationResultConsensus>()
	)().result()

	const result: VlayerVerificationResult = {
		success: consensus.success,
		serverDomain: consensus.serverDomain,
		notaryKeyFingerprint: consensus.notaryKeyFingerprint,
		request: {
			body: null,
			headers: consensus.request.headers,
			method: consensus.request.method,
			raw: consensus.request.raw,
			url: consensus.request.url,
			version: consensus.request.version,
		},
		response: consensus.response,
	}

	if (!result.success) {
		throw new Error('vlayer verification failed')
	}

	return result
}

/**
 * Oracle price data from AggregatorV3Interface.latestRoundData()
 */
export interface OraclePriceData {
	answer: bigint
	updatedAt: number
	decimals: number
}

const aggregatorV3ABI = [
	{
		name: 'latestRoundData',
		type: 'function',
		stateMutability: 'view',
		inputs: [],
		outputs: [
			{ name: 'roundId', type: 'uint80' },
			{ name: 'answer', type: 'int256' },
			{ name: 'startedAt', type: 'uint256' },
			{ name: 'updatedAt', type: 'uint256' },
			{ name: 'answeredInRound', type: 'uint80' },
		],
	},
] as const

/**
 * Read oracle price from on-chain AggregatorV3Interface.
 * All params are explicit (per-token config).
 */
export function readOraclePrice(
	runtime: Runtime<Config>,
	oracleAddress: string,
	chainSelectorName: string,
	decimals: number,
): OraclePriceData {
	const oracleNetwork = getNetworkByChainSelector(chainSelectorName)
	if (!oracleNetwork) {
		throw new Error(`Oracle network not found for chain selector: ${chainSelectorName}`)
	}

	const oracleEvmClient = new EVMClient(oracleNetwork.chainSelector.selector)

	const callData = encodeFunctionData({
		abi: aggregatorV3ABI,
		functionName: 'latestRoundData',
	})

	const result = oracleEvmClient
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: oracleAddress as `0x${string}`,
				data: callData,
			}),
			blockNumber: LATEST_BLOCK_NUMBER,
		})
		.result()

	const decoded = decodeFunctionResult({
		abi: aggregatorV3ABI,
		functionName: 'latestRoundData',
		data: bytesToHex(result.data),
	}) as readonly [bigint, bigint, bigint, bigint, bigint]

	return {
		answer: decoded[1],
		updatedAt: Number(decoded[3]),
		decimals,
	}
}


/**
 * Fasanara NAV extracted from plain-text email body
 */
export interface FasanaraNavData {
	totalNotional: number
	netAccruedInterest: number
	fasanaraNavUSD: number
}

/**
 * Parse Fasanara NAV from a Vlayer fund manager email ObjectClaim.
 * The email body is plain text with key:value lines, e.g.:
 *   Total Notional Amount: 58,489,684.03 USD
 *   Net Accrued Interest (as at Valuation Date): 2,923,112.04 USD
 * Returns null if the expected fields cannot be found.
 */
export function extractFasanaraNavFromEmail(emailClaim: { resolve: (pointer: string) => unknown }): FasanaraNavData | null {
	try {
		const body = emailClaim.resolve(
			'/response/@parseJson(body)/payload/parts/0/body/@decodeBase64(data)'
		) as string

		if (typeof body !== 'string') return null

		const lines = body.split('\n')

		const parseAmount = (line: string): number | null => {
			// Match a number like 58,489,684.03 at the end of the line (before optional USD/currency)
			const match = line.match(/([\d,]+\.?\d*)\s*(?:USD)?[\s]*$/)
			if (!match) return null
			const num = parseFloat(match[1].replace(/,/g, ''))
			return isNaN(num) ? null : num
		}

		let totalNotional: number | null = null
		let netAccruedInterest: number | null = null

		for (const line of lines) {
			const trimmed = line.trim()
			if (totalNotional === null && /total\s+notional\s+amount/i.test(trimmed)) {
				totalNotional = parseAmount(trimmed)
			} else if (netAccruedInterest === null && /net\s+accrued\s+interest/i.test(trimmed)) {
				netAccruedInterest = parseAmount(trimmed)
			}
			if (totalNotional !== null && netAccruedInterest !== null) break
		}

		if (totalNotional === null || netAccruedInterest === null) return null

		return {
			totalNotional,
			netAccruedInterest,
			fasanaraNavUSD: totalNotional + netAccruedInterest,
		}
	} catch {
		return null
	}
}

const erc20ABI = [
	{
		name: 'balanceOf',
		type: 'function',
		stateMutability: 'view',
		inputs: [{ name: 'account', type: 'address' }],
		outputs: [{ name: '', type: 'uint256' }],
	},
] as const

const totalSupplyABI = [
	{
		name: 'totalSupply',
		type: 'function',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'uint256' }],
	},
] as const

export interface OnchainSupplyData {
	supplyRaw: bigint
	supply: number
	decimals: number
}

/**
 * Read ERC-20 totalSupply() at latest block.
 */
export function readOnchainTotalSupply(
	runtime: Runtime<Config>,
	tokenAddress: string,
	decimals: number,
	chainSelectorName: string,
): OnchainSupplyData {
	const network = getNetworkByChainSelector(chainSelectorName)
	if (!network) throw new Error(`Network not found for chain selector: ${chainSelectorName}`)

	const evmClient = new EVMClient(network.chainSelector.selector)

	const callData = encodeFunctionData({ abi: totalSupplyABI, functionName: 'totalSupply' })

	const result = evmClient
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to: tokenAddress as `0x${string}`, data: callData }),
			blockNumber: LATEST_BLOCK_NUMBER,
		})
		.result()

	const supplyRaw = decodeFunctionResult({
		abi: totalSupplyABI,
		functionName: 'totalSupply',
		data: bytesToHex(result.data),
	}) as bigint

	return { supplyRaw, supply: Number(supplyRaw) / Math.pow(10, decimals), decimals }
}

/**
 * On-chain assets data: mTBILL and USDC balances converted to USD
 */
export interface OnchainAssetsData {
	mtbillBalanceRaw: bigint
	mtbillPriceRaw: bigint
	mtbillValueUSD: number
	usdcBalanceRaw: bigint
	usdcValueUSD: number
}

/**
 * Read mTBILL and USDC on-chain balances and convert to USD.
 * mTBILL value = sum of wallet balances × oracle price.
 * USDC value = sum of wallet balances (1 USDC = 1 USD).
 * EVM contract calls do not count toward the 5 HTTP call limit.
 */
export function readOnchainAssets(
	runtime: Runtime<Config>,
	cfg: OnchainAssetsConfig,
): OnchainAssetsData {
	const network = getNetworkByChainSelector(cfg.chainSelectorName)
	if (!network) {
		throw new Error(`Onchain assets network not found for chain selector: ${cfg.chainSelectorName}`)
	}

	const evmClient = new EVMClient(network.chainSelector.selector)

	// Read mTBILL oracle price
	const oraclePriceData = readOraclePrice(
		runtime,
		cfg.mtbillOracleAddress,
		cfg.chainSelectorName,
		cfg.mtbillOracleDecimals,
	)

	// Sum mTBILL balances across all wallets
	let mtbillBalanceRaw = 0n
	for (const wallet of cfg.mtbillWallets) {
		const callData = encodeFunctionData({
			abi: erc20ABI,
			functionName: 'balanceOf',
			args: [wallet as `0x${string}`],
		})
		const result = evmClient
			.callContract(runtime, {
				call: encodeCallMsg({
					from: zeroAddress,
					to: cfg.mtbillTokenAddress as `0x${string}`,
					data: callData,
				}),
				blockNumber: LATEST_BLOCK_NUMBER,
			})
			.result()
		const decoded = decodeFunctionResult({
			abi: erc20ABI,
			functionName: 'balanceOf',
			data: bytesToHex(result.data),
		}) as bigint
		mtbillBalanceRaw += decoded
	}

	// Sum USDC balances across all wallets
	let usdcBalanceRaw = 0n
	for (const wallet of cfg.usdcWallets) {
		const callData = encodeFunctionData({
			abi: erc20ABI,
			functionName: 'balanceOf',
			args: [wallet as `0x${string}`],
		})
		const result = evmClient
			.callContract(runtime, {
				call: encodeCallMsg({
					from: zeroAddress,
					to: cfg.usdcTokenAddress as `0x${string}`,
					data: callData,
				}),
				blockNumber: LATEST_BLOCK_NUMBER,
			})
			.result()
		const decoded = decodeFunctionResult({
			abi: erc20ABI,
			functionName: 'balanceOf',
			data: bytesToHex(result.data),
		}) as bigint
		usdcBalanceRaw += decoded
	}

	const mtbillPriceUSD = Number(oraclePriceData.answer) / Math.pow(10, oraclePriceData.decimals)
	const mtbillBalance = Number(mtbillBalanceRaw) / Math.pow(10, cfg.mtbillTokenDecimals)
	const mtbillValueUSD = mtbillBalance * mtbillPriceUSD

	const usdcBalance = Number(usdcBalanceRaw) / Math.pow(10, cfg.usdcTokenDecimals)
	const usdcValueUSD = usdcBalance // 1 USDC = 1 USD

	return {
		mtbillBalanceRaw,
		mtbillPriceRaw: oraclePriceData.answer,
		mtbillValueUSD,
		usdcBalanceRaw,
		usdcValueUSD,
	}
}

/**
 * 1token report data — equity in millions USD, navBase in fund base currency (e.g. BTC)
 */
export interface OneTokenReportData {
	assets: Record<string, number>
	liabilities: Record<string, number>
	equity: Record<string, number>
	navBase?: number
}

const ONE_TOKEN_API_URL = 'https://api-prod.midas.app/api/transparency/by-timestamp'

function fetchOneTokenReportInternal(
	nodeRuntime: NodeRuntime<Config>,
	tokenName: string,
	timestamp: string,
): OneTokenReportData {
	const url = `${ONE_TOKEN_API_URL}?token=${tokenName}&timestamp=${timestamp}`

	const httpClient = new HTTPClient()
	const response = httpClient.sendRequest(nodeRuntime, {
		url,
		method: 'GET' as const,
		headers: {} as Record<string, string>,
		timeout: '10s',
		cacheSettings: { store: true, maxAge: '30s' },
	}).result()

	const bodyText = response.body ? new TextDecoder().decode(response.body) : ''

	if (response.statusCode !== 200) {
		throw new Error(`1token API returned status ${response.statusCode}: ${bodyText.slice(0, 200)}`)
	}

	if (!bodyText) {
		throw new Error(`1token API returned empty body (status ${response.statusCode})`)
	}

	const fullResponse = JSON.parse(bodyText)
	const report = fullResponse?.reports?.assets_and_liabilities_by_protocol

	if (!report || typeof report.equity?.total !== 'number') {
		throw new Error(`1token response missing equity.total. Body: ${bodyText.slice(0, 300)}`)
	}

	// Return only numeric fields to avoid null values crashing the CRE WASM serializer
	const sanitize = (obj: Record<string, unknown>): Record<string, number> =>
		Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'number' ? v : 0]))

	const navBaseCurrencyTotal = fullResponse?.reports?.nav_by_chain?.pv_base?.total

	return {
		assets: sanitize(report.assets ?? {}),
		liabilities: sanitize(report.liabilities ?? {}),
		equity: sanitize(report.equity ?? {}),
		...(typeof navBaseCurrencyTotal === 'number' ? { navBase: navBaseCurrencyTotal } : {}),
	}
}

export interface SupplyDetailsData {
	supply: number
	price: number
	tvl: number
	timestamp: number
}

function fetchSupplyDetailsInternal(
	nodeRuntime: NodeRuntime<Config>,
	tokenName: string,
): SupplyDetailsData {
	const url = 'https://api-prod.midas.app/api/data/prices/details'
	const httpClient = new HTTPClient()
	const response = httpClient.sendRequest(nodeRuntime, {
		url,
		method: 'GET' as const,
		headers: {} as Record<string, string>,
		timeout: '10s',
		cacheSettings: { store: true, maxAge: '30s' },
	}).result()

	const bodyText = response.body ? new TextDecoder().decode(response.body) : ''
	if (response.statusCode !== 200) throw new Error(`supply/details status ${response.statusCode}`)
	if (!bodyText) throw new Error('supply/details empty body')

	const data = JSON.parse(bodyText)
	// Response structure: { details: { mHyperBTC: { supply, price, tvl, timestamp }, ... }, ... }
	const entry = data?.details?.[tokenName]
	if (!entry || typeof entry.supply !== 'number') {
		const keys = Object.keys(data?.details ?? data).slice(0, 5).join(', ')
		throw new Error(`prices/details: token ${tokenName} not found. Keys: ${keys}`)
	}

	return {
		supply: entry.supply,
		price: entry.price,
		tvl: entry.tvl,
		timestamp: entry.timestamp,
	}
}

export function fetchSupplyDetails(
	runtime: Runtime<Config>,
	tokenName: string,
): SupplyDetailsData {
	return runtime.runInNodeMode(
		(nodeRuntime: NodeRuntime<Config>) => fetchSupplyDetailsInternal(nodeRuntime, tokenName),
		consensusIdenticalAggregation<SupplyDetailsData>()
	)().result()
}

/**
 * Fetch 1token report with CRE consensus.
 * oneTokenApi config is passed explicitly (per-token config).
 * Returns null if unavailable — never blocking.
 */
export function fetchOneTokenReport(
	runtime: Runtime<Config>,
	timestamp: string,
	oneTokenApi: { tokenName: string },
): OneTokenReportData | null {
	return runtime.runInNodeMode(
		(nodeRuntime: NodeRuntime<Config>) => fetchOneTokenReportInternal(
			nodeRuntime,
			oneTokenApi.tokenName,
			timestamp,
		),
		consensusIdenticalAggregation<OneTokenReportData>()
	)().result()
}
