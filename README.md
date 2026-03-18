# Midas POR Workflows

Chainlink CRE workflows for the SAVE Proof of Reserves framework. Contains both the **attestation** and **verification** workflows.

Pre-configured with **mHYPER** as default example. To use with another token, update `fundManager.tokenName` and the relevant proofId/claimType in the config.

## Workflows

### Attestation (`cre/attestation/`)

Listens for `NewClaim` events on the SaveRegistryWithClaim contract, verifies claim data via Vlayer TLS Notary proof, creates a signed attestation with structured claims, and pushes it on-chain.

**Flow:** NewClaim event → Fetch from IPFS → Vlayer verification (BFT consensus) → Build claims → Sign attestation → Upload to IPFS → `setAttestation` on-chain

### Verification (`cre/verification/`)

Listens for `AttestationSet` events, fetches and decompresses the attestation from IPFS, re-verifies the TLS Notary proof via Vlayer, validates all claims, and pushes a verification hash on-chain.

**Flow:** AttestationSet event → Fetch from IPFS → Vlayer re-verification (BFT consensus) → Validate claims → Upload verification → `setVerification` on-chain

## mHYPER default values

The config templates come pre-filled with mHYPER POR values:

| Field | Value |
|---|---|
| Registry | `0x2D6e9F608807436DE5D9603B00Abe3FEd1Bc809d` (mainnet) |
| ProofId | `0xAC9A528065AFB4290AB62FB0EE1A9110D48ED834454D2D04AB369B4832BBDA7A` |
| Fund manager email | `mhyper@hyperithm.com` |
| Token name | `mHYPER` |

To adapt for another token, change the `proofId` in topics, `fundManager.tokenName`, `fundManager.expectedEmail`, and the claim type hash.

## Prerequisites

- [Chainlink CRE CLI](https://docs.chain.link/cre)
- [Bun](https://bun.sh/) runtime
- An Ethereum RPC endpoint
- IPFS node with Kubo RPC API (Basic Auth) — or modify the code to use Pinata
- Vlayer API access (contact Vlayer for `client_id` and `auth_token`)
- Your wallet must be authorized on the registry:
  - Attestation: `setAttestor(proofId, address)`
  - Verification: `authorizeVerifiers(proofId, [address])`

## Setup

```bash
cd cre/attestation   # or cre/verification
bun install
```

Copy and configure the template:
```bash
cp config.template.json config.json
# Fill in your values (proxy address, IPFS, Vlayer, keys)
```

Configure RPC endpoints in `cre/project_template.yaml` and secrets in `.env`.

## Usage

```bash
# Attestation
cre workflow simulate --target save-attester
cre workflow deploy --target save-attester
cre workflow activate --target save-attester

# Verification
cre workflow simulate --target save-verifier
cre workflow deploy --target save-verifier
cre workflow activate --target save-verifier
```

## Secrets

| Secret | Used by | Description |
|---|---|---|
| `CRE_ETH_PRIVATE_KEY` | Both | Ethereum private key for CRE CLI |
| `IPFS_PASSWORD` | Both | IPFS Kubo RPC Basic Auth password |
| `VLAYER_AUTH_TOKEN` | Both | Vlayer API authentication token |
| `ATTESTER_PRIVATE_KEY` | Attestation | Key for signing attestations |
| `VERIFIER_PRIVATE_KEY` | Verification | Key for signing verifications |

## Registry

- **Mainnet**: [`0x2D6e9F608807436DE5D9603B00Abe3FEd1Bc809d`](https://etherscan.io/address/0x2D6e9F608807436DE5D9603B00Abe3FEd1Bc809d)
- **Sepolia**: [`0x4AbE1936AEc4aAC8177eC65e437A1f8726Bc7F10`](https://sepolia.etherscan.io/address/0x4AbE1936AEc4aAC8177eC65e437A1f8726Bc7F10)
