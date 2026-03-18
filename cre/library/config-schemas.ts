/**
 * Shared Zod configuration schemas for SAVE workflows
 */

import { getNetwork, LAST_FINALIZED_BLOCK_NUMBER, LATEST_BLOCK_NUMBER } from '@chainlink/cre-sdk'
import { z } from 'zod'

// EVM Confidence Levels based on @chainlink/cre-sdk
export const EVM_CONFIDENCE_LEVELS = ['finalized', 'safe', 'latest'] as const
export type EVMConfidenceLevel = typeof EVM_CONFIDENCE_LEVELS[number]

/**
 * Schema for EVM log trigger configuration
 */
export const logTriggerConfigSchema = z
	.object({
		chainSelectorName: z.string(),
		address: z.string(),
		topics: z.array(
			z.object({
				values: z.array(z.string()),
			})
		),
		confidence: z.enum(EVM_CONFIDENCE_LEVELS),
	})
	.refine((data) => data.chainSelectorName.trim().length > 0, {
		message: 'Chain selector name cannot be empty',
		path: ['chainSelectorName'],
	})
	.refine((data) => /^0x[a-fA-F0-9]{40}$/.test(data.address), {
		message: 'Invalid Ethereum address format',
		path: ['address'],
	})
	.superRefine((data, ctx) => {
		for (let i = 0; i < data.topics.length; i++) {
			const topicFilter = data.topics[i]
			for (let j = 0; j < topicFilter.values.length; j++) {
				const topic = topicFilter.values[j]
				// Validate that each topic is a valid 32-byte hex hash
				if (!/^0x[a-fA-F0-9]{64}$/.test(topic)) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Invalid topic hash format (must be 0x followed by 64 hex characters)`,
						path: ['topics', i, 'values', j],
					})
				}
			}
		}
	})

/**
 * Schema for registry contract configuration
 */
export const registryConfigSchema = z
	.object({
		address: z.string(),
		gasLimit: z.string(),
		readConfidence: z.enum(EVM_CONFIDENCE_LEVELS),
	})
	.refine((data) => /^0x[a-fA-F0-9]{40}$/.test(data.address), {
		message: 'Invalid Ethereum address format',
		path: ['address'],
	})

/**
 * Schema for IPFS HTTP endpoint configuration
 */
export const ipfsHttpEndpointSchema = z
	.object({
		url: z.string(),
		username: z.string().optional(),
		password: z.string().optional(),
	})
	.refine((data) => /^https?:\/\/.+/.test(data.url), {
		message: 'Invalid HTTP/HTTPS URL format',
		path: ['url'],
	})

/**
 * Schema for IPFS RPC endpoint configuration
 */
export const ipfsRpcEndpointSchema = z
	.object({
		url: z.string(),
		username: z.string(),
	})
	.refine((data) => /^https?:\/\/.+/.test(data.url), {
		message: 'Invalid HTTP/HTTPS URL format',
		path: ['url'],
	})

/**
 * Schema for vlayer endpoint configuration
 */
export const vlayerEndpointSchema = z
	.object({
		url: z.string(),
		clientId: z.string(),
	})
	.refine((data) => /^https?:\/\/.+/.test(data.url), {
		message: 'Invalid HTTP/HTTPS URL format',
		path: ['url'],
	})

/**
 * Map from human-readable confidence levels to CRE protocol format
 */
export const CRE_CONFIDENCE_MAP = {
	finalized: 'CONFIDENCE_LEVEL_FINALIZED',
	safe: 'CONFIDENCE_LEVEL_SAFE',
	latest: 'CONFIDENCE_LEVEL_LATEST',
} as const

const BLOCK_NUMBER_BY_CONFIDENCE = {
	finalized: LAST_FINALIZED_BLOCK_NUMBER,
	safe: LAST_FINALIZED_BLOCK_NUMBER,
	latest: LATEST_BLOCK_NUMBER,
} as const

export function getBlockNumberByConfidence(confidence: EVMConfidenceLevel) {
	return BLOCK_NUMBER_BY_CONFIDENCE[confidence]
}

/**
 * Helper to get network by chain selector name without needing to know if it's testnet or mainnet
 */
export function getNetworkByChainSelector(chainSelectorName: string) {
	// Try testnet first
	let network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName,
		isTestnet: true,
	})
	
	// If not found, try mainnet
	if (!network) {
		network = getNetwork({
			chainFamily: 'evm',
			chainSelectorName,
			isTestnet: false,
		})
	}
	
	return network
}
