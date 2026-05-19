import { z } from 'zod';
import {
	EVM_CONFIDENCE_LEVELS,
	type EVMConfidenceLevel,
	logTriggerConfigSchema,
	registryConfigSchema,
	ipfsHttpEndpointSchema,
	ipfsRpcEndpointSchema,
	getNetworkByChainSelector,
} from '../library/config-schemas.js'

// Re-export for backwards compatibility
export { EVM_CONFIDENCE_LEVELS, type EVMConfidenceLevel, getNetworkByChainSelector }

const vlayerEndpointSchema = z
	.object({
		url: z.string(),
		clientId: z.string(),
	})
	.refine((data) => /^https?:\/\/.+/.test(data.url), {
		message: 'Invalid HTTP/HTTPS URL format',
		path: ['url'],
	});

const attesterConfigSchema = z
	.object({
		publicKey: z.string(),
	})
	.refine((data) => /^0x[a-fA-F0-9]+$/.test(data.publicKey), {
		message: 'Invalid public key format (must be 0x followed by hex characters)',
		path: ['publicKey'],
	});

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const fundManagerConfigSchema = z
	.object({
		expectedEmail: z.string(),
		requiredReceiverEmail: z.string(),
		allowedReceiverEmails: z.array(z.string()).default([]),
		tokenName: z.string(),
	})
	.refine((data) => emailRegex.test(data.expectedEmail), {
		message: 'Invalid sender email address format',
		path: ['expectedEmail'],
	})
	.refine((data) => emailRegex.test(data.requiredReceiverEmail), {
		message: 'Invalid required receiver email address format',
		path: ['requiredReceiverEmail'],
	})
	.refine((data) => data.allowedReceiverEmails.every(e => emailRegex.test(e)), {
		message: 'Invalid allowed receiver email address format',
		path: ['allowedReceiverEmails'],
	});

const httpTriggerConfigSchema = z.object({
	authorizedKeys: z.array(z.object({
		type: z.literal('KEY_TYPE_ECDSA_EVM'),
		publicKey: z.string(),
	})).optional(),
}).optional();

export const configSchema = z
	.object({
		name: z.string(),
		newClaimLogTrigger: logTriggerConfigSchema,
		httpTrigger: httpTriggerConfigSchema,
		attesterProxy: registryConfigSchema,
		ipfsHttpEndpoint: ipfsHttpEndpointSchema,
		ipfsRpcEndpoint: ipfsRpcEndpointSchema,
		vlayerEndpoint: vlayerEndpointSchema,
		attester: attesterConfigSchema,
		fundManager: fundManagerConfigSchema,
	})
	.refine((data) => data.name.trim().length > 0, {
		message: 'Name cannot be empty',
		path: ['name'],
	});

export type Config = z.infer<typeof configSchema>;