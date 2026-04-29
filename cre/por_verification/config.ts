import { z } from 'zod'
import {
	EVM_CONFIDENCE_LEVELS,
	type EVMConfidenceLevel,
	logTriggerConfigSchema,
	registryConfigSchema,
	ipfsHttpEndpointSchema,
	ipfsRpcEndpointSchema,
	getNetworkByChainSelector,
} from '../library/config-schemas.js'

const ipfsPinataEndpointSchema = z
	.object({ url: z.string() })
	.refine((d) => /^https?:\/\/.+/.test(d.url), { message: 'Invalid URL', path: ['url'] })

export { EVM_CONFIDENCE_LEVELS, type EVMConfidenceLevel, getNetworkByChainSelector }

const vlayerEndpointSchema = z
	.object({ url: z.string(), clientId: z.string() })
	.refine((d) => /^https?:\/\/.+/.test(d.url), { message: 'Invalid URL', path: ['url'] })

const verifierConfigSchema = z
	.object({ name: z.string(), publicKey: z.string() })
	.refine((d) => /^0x[a-fA-F0-9]+$/.test(d.publicKey), {
		message: 'Invalid public key format (must be 0x + hex)',
		path: ['publicKey'],
	})

const httpTriggerConfigSchema = z
	.object({
		authorizedKeys: z
			.array(z.object({ type: z.literal('KEY_TYPE_ECDSA_EVM'), publicKey: z.string() }))
			.optional(),
	})
	.optional()

/**
 * Per-token verification config — keyed by proofId (lowercase bytes32 hex)
 */
const tokenVerificationConfigSchema = z
	.object({
		name: z.string(),
		hasOffchainData: z.boolean().default(false),
		vlayerEndpoint: vlayerEndpointSchema.optional(),
	})
	.refine((d) => !d.hasOffchainData || d.vlayerEndpoint != null, {
		message: 'vlayerEndpoint required when hasOffchainData is true',
		path: ['vlayerEndpoint'],
	})

export type TokenVerificationConfig = z.infer<typeof tokenVerificationConfigSchema>

export const configSchema = z
	.object({
		name: z.string(),
		attestationSetLogTrigger: logTriggerConfigSchema,
		httpTrigger: httpTriggerConfigSchema,
		verifierProxy: registryConfigSchema,
		ipfsHttpEndpoint: ipfsHttpEndpointSchema,
		// At least one of these must be configured:
		// - ipfsRpcEndpoint: Kubo RPC (LlamaRisk verifiers)
		// - ipfsPinataEndpoint: Pinata API (Midas verifiers)
		ipfsRpcEndpoint: ipfsRpcEndpointSchema.optional(),
		ipfsPinataEndpoint: ipfsPinataEndpointSchema.optional(),
		verifier: verifierConfigSchema,
		// Token registry — keyed by proofId (lowercase bytes32 hex)
		// To add a new token: add an entry here and run `cre workflow update-config`
		tokens: z.record(z.string(), tokenVerificationConfigSchema),
	})
	.refine((d) => d.name.trim().length > 0, { message: 'Name cannot be empty', path: ['name'] })
	.refine((d) => Object.keys(d.tokens).length > 0, {
		message: 'At least one token must be registered',
		path: ['tokens'],
	})
	.refine((d) => d.ipfsRpcEndpoint != null || d.ipfsPinataEndpoint != null, {
		message: 'Either ipfsRpcEndpoint (Kubo) or ipfsPinataEndpoint (Pinata) must be configured',
		path: ['ipfsRpcEndpoint'],
	})

export type Config = z.infer<typeof configSchema>
