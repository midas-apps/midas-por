import { z } from 'zod';
import {
	logTriggerConfigSchema,
	registryConfigSchema,
	ipfsHttpEndpointSchema,
	ipfsRpcEndpointSchema,
	vlayerEndpointSchema,
} from '../library/config-schemas.js'

const verifierConfigSchema = z
	.object({
		name: z.string(),
		publicKey: z.string(),
	})
	.refine((data) => /^0x[a-fA-F0-9]+$/.test(data.publicKey), {
		message: 'Invalid public key format (must be 0x followed by hex characters)',
		path: ['publicKey'],
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
		attestationSetLogTrigger: logTriggerConfigSchema,
		httpTrigger: httpTriggerConfigSchema,
		verifierProxy: registryConfigSchema,
		ipfsHttpEndpoint: ipfsHttpEndpointSchema,
		ipfsRpcEndpoint: ipfsRpcEndpointSchema,
		vlayerEndpoint: vlayerEndpointSchema,
		verifier: verifierConfigSchema,
	})
	.refine((data) => data.name.trim().length > 0, {
		message: 'Name cannot be empty',
		path: ['name'],
	});

export type Config = z.infer<typeof configSchema>;