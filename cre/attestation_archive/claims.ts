/**
 * Claim creation functions for the Midas SAVE CRE workflow
 */

import type { Runtime } from '@chainlink/cre-sdk'
import type { Config } from './config.js'
import { ObjectClaim, NumericClaim, StringClaim, createVlayerProof } from '@save/core'
import type { VlayerVerificationResult } from './api.js'

/**
 * Create fund manager email object claim with verified email data
 */
export function createFundManagerEmailClaim(
	runtime: Runtime<Config>,
	vlayerVerificationResult: VlayerVerificationResult,
	rawProofData: any
): ObjectClaim {
	// Create TLS Notary proof using the raw proof data from IPFS
	const tlsNotaryProof = createVlayerProof({
		proofData: rawProofData,
		serverDomain: vlayerVerificationResult.serverDomain,
		notaryKeyFingerprint: vlayerVerificationResult.notaryKeyFingerprint,
	})
	
	const claim = new ObjectClaim({
		id: 'fund_manager_claim',
		format: 'json',
		data: vlayerVerificationResult as unknown as Record<string, unknown>,
		// TODO: Add schemaId and schemaHash for validation
		description: 'Total NAV reported by fund manager',
		proof: tlsNotaryProof,
	})
	
	return claim
}

/**
 * Create numeric claim for total NAV value extracted from email
 */
export function createTotalNavClaim(
	runtime: Runtime<Config>,
	emailClaim: ObjectClaim
): NumericClaim {
	const tokenName = runtime.config.fundManager.tokenName

	const parsedTable = emailClaim.resolve(
		'/response/@parseJson(body)/payload/parts/0/body/@decodeBase64(data)/@parseTable(.)'
	) as any[]
	
	const tokenIndex = parsedTable.findIndex((record: any) => record.Token === tokenName)
	
	if (tokenIndex === -1) {
		throw new Error(`${tokenName} token not found in NAV report`)
	}
	
	const dataPointer = `fund_manager_claim#/response/@parseJson(body)/payload/parts/0/body/@decodeBase64(data)/@parseTable(.)/${tokenIndex}/Total NAV`
	
	const claim = NumericClaim.sourceBacked({
		id: 'fund_manager_total_nav',
		dataPointer: dataPointer,
		unit: 'USD',
		description: `${tokenName} Total NAV extracted from verified email body`,
	})
	
	return claim
}

/**
 * Create string claim to verify email sender
 */
export function createEmailSenderClaim(
	runtime: Runtime<Config>,
	emailClaim: ObjectClaim,
	expectedEmail: string
): StringClaim {
	// Parse headers to find the From header
	const headers = emailClaim.resolve(
		'/response/@parseJson(body)/payload/headers'
	) as Array<{ name: string; value: string }>
	
	const fromHeader = headers.find((h: { name: string; value: string }) => h.name === 'From')
	
	if (!fromHeader) {
		throw new Error('From header not found in email')
	}
	
	// Extract email address from "Name <email@domain.com>" format for verification
	const emailMatch = fromHeader.value.match(/<(.+?)>/)
	const senderEmail = emailMatch ? emailMatch[1] : fromHeader.value
	
	// Verify sender matches expected email
	if (senderEmail !== expectedEmail) {
		throw new Error(`Email sender verification failed: expected ${expectedEmail}, got ${senderEmail}`)
	}
	
	// Find the index of the From header in the headers array
	const fromHeaderIndex = headers.findIndex((h: { name: string; value: string }) => h.name === 'From')
	
	// Create source-backed string claim pointing to the raw From header value
	const dataPointer = `fund_manager_claim#/response/@parseJson(body)/payload/headers/${fromHeaderIndex}/value`
	
	const claim = StringClaim.sourceBacked({
		id: 'fund_manager_email_sender_verification',
		dataPointer: dataPointer,
		expectedValue: fromHeader.value,
		description: 'Verification of the email sender in the Vlayer web proof verification of the fund manager email',
	})
	
	return claim
}

/**
 * Extract individual email addresses from a To header value.
 * Handles formats like "Name <email@domain.com>, other@domain.com"
 */
function parseRecipientEmails(toHeaderValue: string): string[] {
	return toHeaderValue.split(',').map(part => {
		const match = part.match(/<(.+?)>/)
		return (match ? match[1] : part).trim()
	}).filter(Boolean)
}

/**
 * Create string claim to verify email receivers.
 * Validates that the required receiver is present and all recipients are recognized.
 */
export function createEmailReceiverClaim(
	runtime: Runtime<Config>,
	emailClaim: ObjectClaim,
	requiredReceiverEmail: string,
	allowedReceiverEmails: string[]
): StringClaim {
	// Parse headers to find the To header
	const headers = emailClaim.resolve(
		'/response/@parseJson(body)/payload/headers'
	) as Array<{ name: string; value: string }>

	const toHeader = headers.find((h: { name: string; value: string }) => h.name === 'To')

	if (!toHeader) {
		throw new Error('To header not found in email')
	}

	// Extract all recipient email addresses
	const recipientEmails = parseRecipientEmails(toHeader.value)

	// Build full allowed set: required email + additional allowed emails
	const allAllowed = [requiredReceiverEmail, ...allowedReceiverEmails]
	const allowedSet = new Set(allAllowed.map(e => e.toLowerCase()))

	// Check required recipient is present
	const hasRequired = recipientEmails.some(e => e.toLowerCase() === requiredReceiverEmail.toLowerCase())
	if (!hasRequired) {
		throw new Error(
			`Email receiver verification failed: required recipient ${requiredReceiverEmail} not found. ` +
			`Got: ${recipientEmails.join(', ')}`
		)
	}

	// Check all recipients are recognized
	const unrecognized = recipientEmails.filter(e => !allowedSet.has(e.toLowerCase()))
	if (unrecognized.length > 0) {
		throw new Error(
			`Email receiver verification failed: unrecognized recipient(s) ${unrecognized.join(', ')}. ` +
			`Allowed: ${allAllowed.join(', ')}`
		)
	}

	// Find the index of the To header in the headers array
	const toHeaderIndex = headers.findIndex((h: { name: string; value: string }) => h.name === 'To')

	// Create source-backed string claim pointing to the raw To header value
	const dataPointer = `fund_manager_claim#/response/@parseJson(body)/payload/headers/${toHeaderIndex}/value`

	const claim = StringClaim.sourceBacked({
		id: 'fund_manager_email_receiver_verification',
		dataPointer: dataPointer,
		expectedValue: toHeader.value,
		description: 'Verification of the email receiver in the Vlayer web proof verification of the fund manager email',
	})

	return claim
}

