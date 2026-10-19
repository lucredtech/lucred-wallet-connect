// Supported-collateral registry — the curated vault / LP / vault share-tokens LCRD accepts as
// COLLATERAL for a USDC credit line, keyed by the SHARE-TOKEN contract (the thing a wallet actually
// holds). This is deliberately SEPARATE from the indexer's "discover every vault" list: the indexer
// enumerates all DeFindex factory vaults for SCORING; this is the risk-approved subset accepted as
// collateral, each with its own sizing (advance rate) and liquidation params.
//
// Network-scoped: the mechanism is identical on testnet and mainnet — only the entries differ. Ship
// testnet now; fill in `mainnet` at launch (same shape) and set COLLATERAL_NETWORK=mainnet. Nothing
// else changes.
//
// Each entry (keyed by share-token contract id):
//   protocol           "defindex" | "aquarius" | "soroswap" | "blend" | ...
//   kind               "vault" | "amm_lp" | "lending"
//   label, symbol      display name + ticker for the UI
//   underlyingClass    a key in POLICY.collateralClasses (drives the haircut): stable|stableFx|rwa|major|incentive|curated
//   advanceBps         max loan as a share of market value (e.g. 7500 = 75%)
//   liquidationLtvBps  LTV at which the position is liquidatable (e.g. 9200 = 92%)
//   priceSource        "underlying" (value via the vault's own get_asset_amounts_per_shares + PRICED_TOKENS)
//   enabled            false = kept in the list for reference but not accepted as collateral

const REGISTRIES = {
  testnet: {
    // The DeFindex USDC vault wired to the testnet pool (over mock USDC CDXDVJLA…35ZJ).
    CCMJ4NKHFHD26Z3OIXIU2MNY3IZZJK2HAIDQI5HECYOE27RXORBB6HKA: {
      protocol: "defindex",
      kind: "vault",
      label: "DeFindex USDC Vault",
      symbol: "dfUSDC",
      underlyingClass: "stable",
      advanceBps: 7500,
      liquidationLtvBps: 9200,
      priceSource: "underlying",
      enabled: true,
    },
    // Add more as they are deployed + risk-approved on testnet, same shape.
  },

  // Seeded at mainnet launch, after risk sign-off, with real vault/LP share-token contract ids.
  // Same entry shape as testnet above. Left empty on purpose until then (empty = fall back to the
  // engine's existing "any priced, transferable position" behaviour, so nothing breaks pre-launch).
  mainnet: {},
};

// Which network's collateral list is active. Defaults to testnet (where we are today); flip to
// "mainnet" via env at launch. Read lazily so tests/ops can override process.env before a call.
function activeNetwork() {
  return process.env.COLLATERAL_NETWORK || process.env.STELLAR_NETWORK || process.env.NETWORK || "testnet";
}

function getCollateralRegistry(network = activeNetwork()) {
  return REGISTRIES[network] || {};
}

// Enabled share-token contract ids for a network — the exact tokens to look for in a wallet.
function supportedShareTokens(network = activeNetwork()) {
  const reg = getCollateralRegistry(network);
  return Object.keys(reg).filter((id) => reg[id].enabled);
}

// Public, UI-friendly list for GET /collateral/supported (hides nothing secret; it's on-chain).
function supportedCollateral(network = activeNetwork()) {
  const reg = getCollateralRegistry(network);
  return Object.entries(reg)
    .filter(([, v]) => v.enabled)
    .map(([shareToken, v]) => ({
      shareToken,
      protocol: v.protocol,
      kind: v.kind,
      label: v.label,
      symbol: v.symbol,
      underlyingClass: v.underlyingClass,
      advanceRate: v.advanceBps / 10000,
      liquidationLtv: v.liquidationLtvBps / 10000,
    }));
}

module.exports = {
  REGISTRIES,
  activeNetwork,
  getCollateralRegistry,
  supportedShareTokens,
  supportedCollateral,
};
