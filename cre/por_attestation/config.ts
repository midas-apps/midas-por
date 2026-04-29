import { z } from 'zod'
import {
	EVM_CONFIDENCE_LEVELS,
	type EVMConfidenceLevel,
	logTriggerConfigSchema,
	registryConfigSchema,
	ipfsHttpEndpointSchema,
	getNetworkByChainSelector,
} from '../library/config-schemas.js'

export { EVM_CONFIDENCE_LEVELS, type EVMConfidenceLevel, getNetworkByChainSelector }

const vlayerEndpointSchema = z
	.object({ url: z.string(), clientId: z.string() })
	.refine((d) => /^https?:\/\/.+/.test(d.url), { message: 'Invalid URL', path: ['url'] })

const attesterConfigSchema = z
	.object({ publicKey: z.string() })
	.refine((d) => /^0x[a-fA-F0-9]+$/.test(d.publicKey), {
		message: 'Invalid public key format (must be 0x + hex)',
		path: ['publicKey'],
	})

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const domainRegex = /^@[^\s@]+\.[^\s@]+$/  // e.g. @fasanara.com

const fundManagerConfigSchema = z
	.object({
		expectedEmail: z.string(),
		requiredReceiverEmail: z.string(),
		allowedReceiverEmails: z.array(z.string()).default([]),
		tokenName: z.string(),
	})
	.refine((d) => emailRegex.test(d.expectedEmail) || domainRegex.test(d.expectedEmail), {
		message: 'Invalid sender email (must be a full email or a domain like @fasanara.com)',
		path: ['expectedEmail'],
	})
	.refine((d) => emailRegex.test(d.requiredReceiverEmail), {
		message: 'Invalid required receiver email',
		path: ['requiredReceiverEmail'],
	})

const oneTokenApiSchema = z.object({
	tokenName: z.string(),
	useNavBase: z.boolean().default(false),
})

const onchainAssetsSchema = z.object({
	mtbillWallets: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)),
	mtbillTokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
	mtbillTokenDecimals: z.number().default(18),
	mtbillOracleAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
	mtbillOracleDecimals: z.number().default(8),
	usdcWallets: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)),
	usdcTokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
	usdcTokenDecimals: z.number().default(6),
	chainSelectorName: z.string().default('ethereum-mainnet'),
})
export type OnchainAssetsConfig = z.infer<typeof onchainAssetsSchema>


const ipfsPinataEndpointSchema = z
	.object({ url: z.string() })
	.refine((d) => /^https?:\/\/.+/.test(d.url), { message: 'Invalid URL', path: ['url'] })

const httpTriggerConfigSchema = z
	.object({
		authorizedKeys: z
			.array(z.object({ type: z.literal('KEY_TYPE_ECDSA_EVM'), publicKey: z.string() }))
			.optional(),
	})
	.optional()

/**
 * Per-token configuration — add a new entry here to support a new token.
 * Key is the proofId (bytes32 hex, lowercase): sha256(proofName)
 */
const supplyTokenSchema = z.object({
	address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
	decimals: z.number().default(18),
	chainSelectorName: z.string().default('ethereum-mainnet'),
})
export type SupplyTokenConfig = z.infer<typeof supplyTokenSchema>

const tokenConfigSchema = z.object({
	name: z.string(),
	fundManager: fundManagerConfigSchema.optional(),
	oneTokenApi: oneTokenApiSchema.optional(),
	onchainAssets: onchainAssetsSchema.optional(),
	supplyToken: supplyTokenSchema.optional(),
})

export type TokenConfig = z.infer<typeof tokenConfigSchema>

export const configSchema = z
	.object({
		name: z.string(),
		newClaimLogTrigger: logTriggerConfigSchema,
		httpTrigger: httpTriggerConfigSchema,
		attesterProxy: registryConfigSchema,
		ipfsHttpEndpoint: ipfsHttpEndpointSchema,
		ipfsPinataEndpoint: ipfsPinataEndpointSchema,
		attester: attesterConfigSchema,
		overcollateralizationThreshold: z.number().min(0).max(1).default(0.995),
		oneTokenDeviationThresholdPercent: z.number().min(0).max(100).default(5),
		// Token registry — keyed by proofId (lowercase bytes32 hex)
		// To add a new token: add an entry here and run `cre workflow update-config`
		tokens: z.record(z.string(), tokenConfigSchema),
	})
	.refine((d) => d.name.trim().length > 0, { message: 'Name cannot be empty', path: ['name'] })
	.refine((d) => Object.keys(d.tokens).length > 0, {
		message: 'At least one token must be registered',
		path: ['tokens'],
	})

export type Config = z.infer<typeof configSchema>
