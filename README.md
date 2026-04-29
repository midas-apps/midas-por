# Midas PoR — CRE Workflows

Chainlink CRE workflows for the SAVE Proof of Reserves framework. Implements NAV-based overcollateralization attestation and verification for Midas tokens.

## Workflows

### Attestation (`cre/por_attestation/`)

Listens for `NewClaim` events (ops claim type) on the SaveRegistryWithClaim contract. Fetches the ops claim from IPFS, reads on-chain oracle price and token supply, optionally verifies the fund manager email via Vlayer TLS Notary, runs the overcollateralization check, builds a signed SAVE attestation, and pushes it on-chain.

**Flow:**
`NewClaim` event → Fetch ops claim from IPFS → Read oracle price (Chainlink) → Read on-chain supply → [Vlayer TLS verification] → Fetch 1token report → Overcollateralization check → Build & sign attestation → Upload to IPFS → `setAttestation` on-chain

### Verification (`cre/por_verification/`)

Listens for `AttestationSet` events. Fetches the attestation from IPFS, verifies all claims using the SAVE framework (`@save/core`), re-verifies Vlayer TLS proofs for tokens with offchain data, and pushes the verification result on-chain.

**Flow:**
`AttestationSet` event → Fetch attestation from IPFS → Verify claims (SAVE) → [Vlayer re-verification] → Upload verification → `setVerification` on-chain

---

## Supported Tokens

| Token | proofId | Vlayer (offchain data) |
|---|---|---|
| mFONE | `0x9701c16c2aa2589b3fef161e3d13f4b38a9e0c8ad4b827bff12cf65a6a3ef234` | Yes (Fasanara email) |
| mHyperBTC | `0xf77ebd862996bb55a1c85ab27e4c554e0e77f691d74e8b63bf4849007db4cbc9` | No |

proofIds are computed as `sha256(proofName)` (SHA-256, not keccak256).

---

## Overcollateralization

Before pushing any attestation, the workflow verifies the token is overcollateralized. Two methods are tried in order — if both fail, no attestation is pushed.

### Method 1 — External data (preferred)

**Primary**: `1token equity.total × 1e6 / totalSupplyTokens / oraclePrice > threshold`

**Fallback within Method 1** (tokens with `onchainAssets` config):
`(fasanaraNavUSD + mtbillValueUSD + usdcValueUSD) / totalSupplyTokens / oraclePrice > threshold`

### Method 2 — Internal fallback (ops NAV)

`navReportedByOps / totalSupplyCrossChainReportedByOps / oraclePrice > threshold`

Default threshold: `0.995`

---

## Attestation Claims

All `cre_consensus` claims are produced by the Chainlink DON and trusted as-is by verifiers.

| Claim ID | Type | Description |
|---|---|---|
| `ops_claim` | object / cre_consensus | Ops team data: token, NAV, supply, oracle address |
| `oracle_price` | object / cre_consensus | Chainlink oracle price (`priceRaw`, `oracleLastUpdatedAt`, `oracleLastUpdatedAtISO`) |
| `oracle_price_usd` | numeric / source-backed | Resolved from `oracle_price#/priceRaw` |
| `onetoken_report` | object / cre_consensus | 1token portfolio report (assets, liabilities, equity) |
| `onetoken_total_nav` | numeric / source-backed | Resolved from `onetoken_report#/equity/total` |
| `onchain_supply` | object / cre_consensus | ERC-20 `totalSupply()` at attestation time + `readAt` timestamp |
| `overcollateralization` | object / cre_consensus | Check result: `overcollateralizationType` (`method-1` / `method-2`), ratio, threshold, passed |
| `overcollateralization_ratio` | numeric / source-backed | Resolved from `overcollateralization#/ratio` |
| `fund_manager_claim` | object / tls_notary | Vlayer TLS proof of fund manager email (offchain tokens only) |
| `fund_manager_total_nav` | numeric / source-backed | Total NAV from email table (offchain tokens only) |
| `fund_manager_email_sender_verification` | string / source-backed | Email sender verification (offchain tokens only) |
| `fund_manager_email_receiver_verification` | string / source-backed | Email receiver verification (offchain tokens only) |

---

## Prerequisites

- [Chainlink CRE CLI](https://docs.chain.link/cre)
- [Bun](https://bun.sh/) runtime
- An Ethereum RPC endpoint (mainnet for both targets; Sepolia for dev target)
- Pinata account for IPFS pinning
- Vlayer API access for tokens with offchain data (`auth_token`)
- Your attester/verifier address must be authorized on the registry for each proofId
- A `SaveCreReceiverProxy` deployed and configured — **each party running a workflow needs their own instance** (see below)

---

## Setup

```bash
cd cre/por_attestation   # or cre/por_verification
bun install
```

Create your environment files (gitignored):
```bash
cp cre/.env.example cre/.env.dev   # dev/Sepolia — old deployer wallet
cp cre/.env.example cre/.env.prod  # prod/mainnet — new deployer wallet
# Fill in your values
```

Configure your RPC endpoints in `cre/project.yaml`.

Prod config files (`*.prod.json`) are gitignored — create them locally from the dev configs and fill in mainnet addresses.

---

## Deploy

From the `cre/` directory:

```bash
# Dev (Sepolia)
cre workflow deploy ./por_attestation \
  --config /path/to/config.por_attestation.dev.json \
  --target por-attester-dev \
  -R . --env .env.dev --yes

cre workflow deploy ./por_verification \
  --config /path/to/config.por_verification.dev.json \
  --target por-verifier-dev \
  -R . --env .env.dev --yes

# Prod (Mainnet)
cre workflow deploy ./por_attestation \
  --config /path/to/config.por_attestation.prod.json \
  --target por-attester-prod \
  -R . --env .env.prod --yes

cre workflow deploy ./por_verification \
  --config /path/to/config.por_verification.prod.json \
  --target por-verifier-prod \
  -R . --env .env.prod --yes
```

---

## Secrets

Defined in `cre/.env.dev` / `cre/.env.prod` (gitignored). See `cre/.env.example` for the template.

| Secret (env var) | CRE secret name | Used by | Description |
|---|---|---|---|
| `CRE_ETH_PRIVATE_KEY` | — | CLI only | Ethereum key for CRE CLI deploy operations |
| `PINATA_JWT` | `pinatajwt` | Both | Pinata JWT for IPFS pinning |
| `VLAYER_AUTH_TOKEN` | `vlayerauthtoken` | Both | Vlayer API authentication token |
| `ATTESTER_PRIVATE_KEY` | `attesterprivatekey` | Attestation | Key for signing SAVE attestation documents |
| `VERIFIER_PRIVATE_KEY` | `verifierprivatekey` | Verification | Key for signing SAVE verification documents |
| `IPFS_PASSWORD` | `ipfspassword` | Both | IPFS Kubo RPC Basic Auth password (if using self-hosted node) |

---

## Config

Each workflow has a JSON config file per environment. Key fields:

- `attester.publicKey` / `verifier.publicKey` — full ECDSA public key (65 bytes, `0x04...`) of the signing wallet
- `ipfsPinataEndpoint.groupId` — optional Pinata group ID to organize uploaded files
- `tokens` — registry of supported tokens, keyed by proofId

To add a new token: add an entry to `tokens` in the config and redeploy.

---

## SaveCreReceiverProxy

The Chainlink DON cannot write directly to the registry. It calls `onReport()` on a `SaveCreReceiverProxy`, which decodes the report and forwards it to the registry as `setAttestation` or `setVerification`.

**Each party running a workflow must deploy their own proxy instance** and have it authorized on the registry for the relevant proofId.

| Who | Workflow | Registry authorization needed |
|---|---|---|
| Midas | Attestation | `setAttestor(proofId, proxyAddress)` |
| Any verifier (Midas, LlamaRisk, auditor…) | Verification | `authorizeVerifiers(proofId, [proxyAddress])` |

To run the verification workflow independently:
1. Deploy your own `SaveCreReceiverProxy` (source: `@save/core/contracts/src/save-cre-receiver-proxy/SaveCreReceiverProxy.sol`)
2. Contact Midas to authorize your proxy address on the registry for the proofIds you want to verify
3. Set `verifierProxy.address` in your config to your proxy address

Constructor parameters:

| Parameter | Value |
|---|---|
| `_registry` | `0x2D6e9F608807436DE5D9603B00Abe3FEd1Bc809d` (mainnet) |
| `_workflowId` | `bytes32(0)` |
| `_expectedForwarder` | `0x0b93082D9b3C7C97fAcd250082899BAcf3af3885` (mainnet KeystoneForwarder) |
| `_expectedAuthor` | Your CRE workflow deployer address |
| `_expectedWorkflowName` (attestation) | `sha256("midas_por_attestation_prod")[0:5 bytes]` as bytes10 |
| `_expectedWorkflowName` (verification) | `sha256("midas_por_verification_prod")[0:5 bytes]` as bytes10 |
| `_isReportWriteSecured` | `true` (recommended for production) |
| `_initialOwner` | Your admin address |

---

## Registry

| Network | Address |
|---|---|
| Mainnet | [`0x2D6e9F608807436DE5D9603B00Abe3FEd1Bc809d`](https://etherscan.io/address/0x2D6e9F608807436DE5D9603B00Abe3FEd1Bc809d) |
| Sepolia | [`0x4AbE1936AEc4aAC8177eC65e437A1f8726Bc7F10`](https://sepolia.etherscan.io/address/0x4AbE1936AEc4aAC8177eC65e437A1f8726Bc7F10) |

## Future improvements

### Config-driven email parser

Currently `extractFasanaraNavFromEmail` is hardcoded to Fasanara's plain-text email format (looks for `Total Notional Amount` + `Net Accrued Interest`). Supporting a new fund manager requires a code change and workflow redeploy.

**Planned improvement**: make the parser fully config-driven via `fundManager.emailParser` in the token config. Each field to extract is specified by a regex + sign (add/subtract), so NAV = sum of matched fields. Example:

```json
"fundManager": {
  "expectedEmail": "@fasanara.com",
  "requiredReceiverEmail": "midas@vlayer.xyz",
  "tokenName": "mFONE",
  "emailParser": {
    "navFields": [
      { "regex": "total\\s+notional\\s+amount", "sign": 1 },
      { "regex": "net\\s+accrued\\s+interest", "sign": 1 }
    ]
  }
}
```

With this, adding a new fund manager = update config only, no redeploy. The fund manager email format can be standardized freely.

### Cross-chain supply API

Currently `totalSupplyCrossChainReportedByOps` is manually reported by the ops team in the ops claim. A backend API endpoint (`/api/data/supply/total/address/{address}`) is planned to replace this in Method 1 — the workflow will fetch the cross-chain supply directly, removing the manual step. Method 2 (internal fallback) will continue to use the ops-reported value.

---

## Reading on-chain data

All IPFS content (ops claims, attestations, verifications) is stored as gzip-compressed JSON. To read it from a bytes32 hash:

```javascript
// 1. Convert bytes32 → IPFS CID
function bytes32ToCid(bytes32) {
  const hex = bytes32.replace('0x', '')
  const multihash = '1220' + hex
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let num = BigInt('0x' + multihash)
  let result = ''
  while (num > 0n) { result = ALPHABET[Number(num % 58n)] + result; num = num / 58n }
  return result
}

// 2. Fetch + decompress (browser)
async function fetchFromIpfs(cid) {
  const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`)
  const ds = new DecompressionStream('gzip')
  const decompressed = res.body.pipeThrough(ds)
  return JSON.parse(await new Response(decompressed).text())
}
```
