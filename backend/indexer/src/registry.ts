/**
 * Multi-protocol contract address routing map — mainnet ("pubnet") addresses,
 * matching GALEXIE_START_LEDGER's 2024-01-01 mainnet start.
 *
 * Every address below was pulled from a primary source and cross-checked,
 * never copied from a search-engine summary — mainly each protocol's own
 * docs/GitHub, and (for the entries added after the first pass) DefiLlama's
 * own TVL-adapter source code, which encodes the exact contract addresses
 * DefiLlama itself reads on-chain balances from
 * (https://github.com/DefiLlama/DefiLlama-Adapters/tree/main/projects).
 * Protocols are ordered roughly by mainnet TVL per DefiLlama's Stellar chain
 * page (https://defillama.com/chain/Stellar) at research time (2026-09-20).
 * See README.md's "Registry research notes" for what's still missing, why,
 * and for protocols that could not be confirmed to exist on Stellar at all.
 */
export interface ProtocolInfo {
  protocolName: string;
  category: string;
  // For contracts where one contract = one asset (a per-asset vault, e.g.
  // Peridot's separate XLM/USDC/EURC vaults) rather than the asset being
  // named inside each event - confirmed on real data that some of these
  // (Peridot's `mint`, Stellar DeFi Hub's `DEPOSIT`) carry NO asset address
  // in the event at all, so xdrParser.ts's per-event asset detection finds
  // nothing to report. Set this and it's used as the fallback.
  defaultAssetCode?: string;
}

export const PROTOCOL_REGISTRY: Record<string, ProtocolInfo> = {
  // --- Blend (lending) — #1 by TVL (~$150m) — 12 real pools, fully resolved ---
  // https://docs.blend.capital/mainnet-deployments (factory/backstop);
  // pool addresses are NOT fixed - Blend pools are deployed dynamically, so
  // I enumerated the real, current set the same way DefiLlama's own adapter
  // does: the factory's `deploy` events (via stellar.expert), cross-checked
  // against backstop.reward_zone() (empty right now - pool rewards rotate,
  // so it's a normal but unreliable-alone signal, exactly as DefiLlama's own
  // comment on this warns: https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/blend-pools-v2/index.js).
  // One of these 12 (CAJJZS...) is independently confirmed real because it's
  // the exact pool Templar's own vault deposits into via its blend_adapter -
  // two unrelated sources agreeing on the same address.
  //
  // BORROW-SIDE COVERAGE, verified against 1539 real events across 3 of
  // these pools: `borrow`, `supply_collateral` and `withdraw_collateral` are
  // 100% directly user-attributable (topics are [event_name, asset_contract,
  // user_account] - 3 topics, not 2, which is why an earlier pass here
  // wrongly concluded Blend borrow events had no user address at all: that
  // check only looked at topics[1] and missed topics[2]). `pickAmount`/
  // findUserAddress in xdrParser.ts need no protocol-specific code for this -
  // the generic "find the address that resolves to an account, not a
  // contract" fix (added for this exact reason) handles it correctly.
  //
  // SUPPLY-SIDE COVERAGE IS THE OPPOSITE, and a genuinely interesting real
  // finding: `supply` (606 sampled events), `withdraw` (694) and `repay`
  // (87) are almost never directly user-attributable - 0.2%, 0%, and 8%
  // resolved to a real account respectively, because in practice these
  // calls come from OTHER contracts composing on top of Blend (e.g.
  // Templar's blend_adapter depositing pooled user funds) rather than end
  // users calling the pool directly. findUserAddress correctly drops these
  // (an aggregator contract is not the depositor) rather than misattribute
  // them - so expect real borrow/collateral rows from this registry entry,
  // but very few raw supply/withdraw/repay rows; the actual depositors
  // behind an aggregator's contract-attributed supply would need to be
  // read from that aggregator's OWN user-facing event instead (e.g. Templar's,
  // Stellar DeFi Hub's, DeFindex's) - a real, unresolved cross-protocol
  // correlation gap, not a bug in this parser.
  CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU: { protocolName: 'blend', category: 'lending_pool_factory' },
  CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7: { protocolName: 'blend', category: 'lending_backstop' },
  CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI: { protocolName: 'blend', category: 'lending_pool' },
  CADR6Q2UOCDJAGXMAB2E6SRT35STLZ2IGLZUCXJQG7TC2LNKCU5RTQVY: { protocolName: 'blend', category: 'lending_pool' },
  CALRF5I2OCJCU577R6MZBCY5IIXNMAAG6PNMN7GUKEYIXBJCJN2FJRVI: { protocolName: 'blend', category: 'lending_pool' },
  CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF: { protocolName: 'blend', category: 'lending_pool' },
  CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC: { protocolName: 'blend', category: 'lending_pool' },
  CB4OFHAY2TAEYUVPOJS36S657C6NYMSIFUNCCA5AHYT46Y5XUID3O2ED: { protocolName: 'blend', category: 'lending_pool' },
  CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS: { protocolName: 'blend', category: 'lending_pool' },
  CBNR7PYFY775UG7W37B4OJG2OBBUKLFW6VIBHFDKKLR2HECPRMRZMDK3: { protocolName: 'blend', category: 'lending_pool' },
  CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD: { protocolName: 'blend', category: 'lending_pool' }, // = the pool Templar's blend_adapter deposits into
  CAIYBZSBI6XXI3W7EDXDRWLUBK3RCAPHTK4DNX74DZGWE53KYWBHE236: { protocolName: 'blend', category: 'lending_pool' },
  CC4HHXPKR3FIXUQEC53MAK2IVWD6APAEBBXP5XCIW5FISN6PQOAC6UXG: { protocolName: 'blend', category: 'lending_pool' },
  CDZVHCO7LDUJZSME3PJPJXAKT7F6W5IXSOXTJ2QEK3Y2X2CDUREBUMUY: { protocolName: 'blend', category: 'lending_pool' },

  // --- Aquarius (AMM) — #2 by TVL (~$38m) — RESOLVED via live discovery, corrected 2026-09-29 ---
  // https://docs.aqua.network/developers/code-examples/prerequisites-and-basics
  // WAS WRONG below until 2026-09-29: this was assumed to be one shared AMM
  // contract holding all pools as internal state. It is NOT - it's
  // Aquarius's LiquidityPoolRouter, and pools are individually deployed
  // contracts exactly like Soroswap's pairs, confirmed by reading
  // DefiLlama's real adapter source (not re-derived):
  // https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/aqua-network/index.js
  // src/poolDiscovery.ts's discoverAquariusPools() calls the router's
  // get_tokens_sets_count/get_pools_for_tokens_range live at startup and
  // merges the real pool addresses into this registry at runtime - this
  // static entry is kept only because the router itself IS also a real
  // contract users can invoke directly (routing calls), not because it
  // covers the pools. See project_missed_contracts_backfill_list memory:
  // years of direct per-pool Aquarius activity were likely missed before
  // this fix and need reindexing.
  CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK: { protocolName: 'aquarius', category: 'amm_liquidity' },

  // --- Stellar DeFi Hub (vault farm) — #3 by TVL (~$35m) ---
  // Not in the original spec; found via DeFiLlama's Stellar rankings.
  // https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/stellarDefiHub/index.js
  // Three fixed per-asset vaults (XLM / USDC / PYUSD).
  CA54LVHMAY7HGLMVPN4W72XJB4OGKVZBZX26FWN6JD4P3HJFWQUQEHJO: { protocolName: 'stellar_defi_hub', category: 'yield_savings', defaultAssetCode: 'XLM' },
  CAHEWHOPPDBQYFMAOLDOXXGUX2BCR7EXP4CWYCRY3NEAJB35YPZMMJFF: { protocolName: 'stellar_defi_hub', category: 'yield_savings', defaultAssetCode: 'USDC' },
  CAQRAXBU6G4AAX4BZ7R4WLB62TSVAQFS5ZXJDVXRLAU2NZ2ZTGU5QOYB: { protocolName: 'stellar_defi_hub', category: 'yield_savings', defaultAssetCode: 'PYUSD' },

  // --- Upshift / Gami Labs (tokenized yield vaults) — #4/#5 by TVL (~$29.5m each) ---
  // Not in the original spec. These are the SAME underlying vaults: Upshift
  // (built by August Digital) brands its Stellar deployment "Gami" - the two
  // DefiLlama listings both point at this pair of OZ FungibleVault contracts.
  // https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/upshift/index.js
  CCL3WITWFFXIHV2I52ECV5DPIEOFSTU3PBPR53ILPLF2IP5KHECXRUTY: { protocolName: 'gami_upshift', category: 'yield_savings', defaultAssetCode: 'USDC' }, // Gami earnUSDC
  CC6TRAPQD3NK7THUKWPV5SL2JHKQGNXZVB6S6MVYFSLRWAKEFUWZKZ7J: { protocolName: 'gami_upshift', category: 'yield_savings', defaultAssetCode: 'XLM' }, // Gami earnXLM

  // --- DeFindex (yield aggregator) — #6 by TVL (~$20m) — RESOLVED via live discovery ---
  // Vaults are deployed through a real on-chain factory
  // (CDKFHFJIET3A73A2YN4KV7NSV32S6YGQMUFH3DNJXLBWL4SKEGVRNFKI). An earlier
  // pass assumed otherwise and relied on DeFindex's own discover API
  // (https://api.defindex.io/vault/discover?network=mainnet) plus a static
  // fallback list for vaults it missed (the "Neko" family) - confirmed
  // 2026-09-30 that combination covered only 23 of 117 real vaults. Fixed by
  // switching src/poolDiscovery.ts's discoverDeFindexVaults() to call the
  // factory's total_vaults()/get_vault_by_index() directly, which enumerates
  // every vault ever deployed - self-healing going forward, no static list
  // needed here at all (the former Neko entries are now redundant with the
  // dynamic discovery and were removed - see poolDiscovery.ts for the full
  // writeup and project_missed_contracts_backfill_list memory for the
  // reindex this feeds).

  // --- Sushi Stellar (AMM) — #8 by TVL (~$15m) — RESOLVED via live discovery ---
  // I was WRONG to doubt this existed in an earlier pass - it's a real
  // Soroban deployment. This factory address alone catches nothing (pools
  // are separately deployed contracts, confirmed 58 real ones exist via
  // pool_created events). src/poolDiscovery.ts's discoverSushiPools() calls
  // the factory's full event history via stellar.expert (not just RPC's
  // ~4-month retention) at indexer startup and merges the real pool
  // addresses into this registry at runtime.
  // https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/sushi-stellar/index.js
  CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF: { protocolName: 'sushi_stellar', category: 'amm_factory' },

  // --- Templar — supply-side vault only; the real borrow/CDP contract is on NEAR, not Stellar ---
  // #9 by TVL (~$12.8m). https://github.com/Templar-Protocol/contracts
  // CATEGORY CORRECTED from the first pass, which guessed `cdp_vault_debt`:
  // reading this vault's actual Rust source (src/effects/mod.rs) showed its
  // entire event vocabulary is allocation/withdrawal/payout/fee mechanics
  // for a yield vault forwarding deposits into an underlying Blend pool (the
  // exact pool address included above) - no Borrow/Repay/Debt/Collateral
  // event anywhere in it.
  // RESOLVED, not just "not found": I went looking for the actual borrowing
  // contract in Templar's other repos and found it - it doesn't exist on
  // Stellar at all. Templar-Protocol/templar-liquidator (their liquidation
  // bot) imports `near_sdk`, uses NEP-330 (a NEAR Protocol standard) contract
  // versioning, and operates on `templar_common::borrow::{BorrowPosition,
  // BorrowStatus}` via a `templar_gateway_client` - Templar's actual debt
  // accounting and borrowing happens on NEAR Protocol, coordinated
  // cross-chain; Stellar only ever hosts the deposit/collateral-custody
  // side registered below. There is nothing further to find here.
  // Also still true: this deployment's folder is named "tTUSDC" ("Test
  // Templar USDC") - may be a canary/test market. Verify with Templar directly.
  CA3M5DXSSDUSTAXIPH5GGTS55SIZJKUHKQEOJVZ57GMZKEQCGZBTY7ZV: { protocolName: 'templar', category: 'yield_savings' },

  // --- Huma Finance V2 / Arf Pool (RWA trade finance) — #12 by TVL (~$2.7m) ---
  // RESOLVED, definitively: checked its ENTIRE event history (124 events,
  // all of it, via stellar.expert - not just RPC's live ~4-month window).
  // 122 are `YieldTrackerRefreshed` (a periodic system refresh) and the
  // other 2 are contract-upgrade events. Zero user-facing events of any
  // kind, ever. This is architectural, not a data-availability gap: this
  // contract simply never emits per-user activity - its real numbers live
  // in contract storage, read via view functions (TrancheAddresses/
  // TrancheAssets), exactly like DefiLlama's own adapter reads it. No
  // pipeline improvement will make this registry entry produce event-based
  // rows; keeping it registered mainly documents that fact for anyone who
  // asks "why is Huma's RWA activity missing" later.
  // https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/huma-v2/index.js
  CAADAYJOZF5HXPVZXBXA3PLCU7OSRW34OKVXG2676KAGZVZBI6EYQ73L: { protocolName: 'huma_finance', category: 'rwa_trade_finance' },

  // --- Phoenix DeFi Hub (AMM) — all 7 of their live pools ---
  // The user found 3 pool URLs directly from app.phoenix-hub.io; I pulled
  // the app's own "All Pools (7)" listing (via its client-side pool-card
  // buttons, which route to /pools/{contractId} — the app doesn't expose an
  // API or DOM href for these, so each address was captured by actually
  // clicking through) to get the complete, exhaustive set - "ACTIVE POOLS: 7"
  // on their own page confirms nothing is missing. Each address independently
  // confirmed as a real deployed contract via stellar.expert.
  //
  // MAJOR SHAPE DIFFERENCE, found by pulling and decoding a real swap:
  // Phoenix does not emit one consolidated event per swap like every other
  // protocol here - it emits one event PER FIELD (`[swap, sender]`,
  // `[swap, offer_amount]`, `[swap, buy_token]`, ... 8 separate events for
  // one swap), using scvString topics instead of scvSymbol. xdrParser.ts's
  // parseContractEventGroup()/assembleFromFields() now detects and
  // correlates these fragments back into one row - verified against this
  // exact real event group. CAVEAT: the "sender" field can itself be a
  // contract address (e.g. Phoenix's own multihop router calling the pool
  // on a user's behalf) rather than the end user's wallet - confirmed in
  // the very group used to verify this, so userAddress may sometimes be a
  // router, not a person, for swaps that were routed rather than direct.
  //
  // Two pools (USDC-VEUR, USDC-VCHF) pair against VNX's tokenized euro/franc
  // - the same VNX flagged earlier as "doesn't fit this pipeline" because its
  // *issuer* tokens are classic Stellar assets. That's still true, but here
  // VEUR/VCHF are just the trading pair inside a real Soroban pool contract,
  // so THIS activity (swaps/liquidity events on the Phoenix pool itself) is
  // perfectly capturable - it's RWA-adjacent trading volume worth having.
  CBHCRSVX3ZZ7EGTSYMKPEFGZNWRVCSESQR3UABET4MIW52N4EVU6BIZX: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // XLM-USDC, $3.8k TVL
  CBCZGGNOEUZG4CAAE7TGTQQHETZMKUT4OIPFHHPKEUX46U4KXBBZ3GLH: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // XLM-PHO, $15.5k TVL (largest pool, but quiet in RPC's retention window)
  CBISULYO5ZGS32WTNCBMEFCNKNSLFXCQ4Z3XHVDP4X4FLPSEALGSY3PS: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // XLM-EURC, $5.2k TVL
  CDQLKNH3725BUP4HPKQKMM7OO62FDVXVTO7RCYPID527MZHJG2F3QBJW: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // USDC-VEUR, $9.9k TVL (RWA-adjacent, see above)
  CBW5G5SO5SDYUGQVU7RMZ2KJ34POM3AMODOBIV2RQYG4KJDUUBVC3P2T: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // USDC-VCHF, $10.1k TVL (RWA-adjacent, see above)
  CBENABXP6C4C7WG6KB7JQOTDS5GIIXF3IX3PIYNZFCDZDWUHITO2HZ4S: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // XLM-USDC (blended), $183 TVL, swaps currently paused per Phoenix's own UI
  CCPPPTDWJIWXQUQ2CN64S5JYQ7GYWVZIT7YWUUTH75HKIZX53Z2CE3XI: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // PHO-USDC, $1.6k TVL

  // --- Phoenix LP-STAKING contracts (added 2026-10-03) ---
  // Each Phoenix pool deploys its own staking contract (the pool's
  // `query_stake_contract_address`); LPs `bond` LP tokens there and earn reward
  // tokens. Found by calling that read-only fn on every pool above - the 7th
  // ("blended" XLM-USDC, CBENABXP...) returns ITSELF, i.e. has no separate stake
  // contract. Registered under the SAME protocolName as the pools on purpose:
  // staking is the same protocol, so it must not add a second protocol to a
  // wallet's breadth count. Events are per-field fragments exactly like the
  // pools' (`[bond,user]`, `[bond,token]`, `[bond,amount]`, `[unbond,...]`,
  // `[withdraw_rewards,user]`, `[withdraw_rewards,reward_token]`), so the
  // existing assembleFromFields path handles them - no new parser code.
  // KNOWN LIMITS (from contracts/stake/src/contract.rs): `withdraw_rewards`
  // carries NO AMOUNT (the payout is a token `transfer` on the reward token's own,
  // unregistered contract), so claims count toward months-claimed but can't be
  // priced; and rewards settled INSIDE `unbond` emit only `[withdraw_rewards,
  // reward_token]` with no user, which assembleFromFields drops. See
  // REWARD_SOURCES in credit-score-api for how these are scored.
  CAF3UJ45ZQJP6USFUIMVMGOUETUTXEC35R2247VJYIVQBGKTKBZKNBJ3: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // stake: XLM-USDC pool
  CBRGNWGAC25CPLMOAMR7WBPOF5QTFA5RYXQH4DEJ4K65G2QFLTLMW7RO: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // stake: XLM-PHO pool
  CDEQYRWFU3IHPRR6H6VOQRUU3JFS6DTUYUL4YAQSD3ALB5IPBTEOZUFM: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // stake: XLM-EURC pool
  CCP653KENMYCAYQ3PHJDT6PITMG4XYKVWV3OEDDCOAOS6Z4GOMXGYH3Z: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // stake: USDC-VEUR pool
  CCIWIW6ESCCCFMEI5QOSUHDKTMBEMRJ22F7GPYNRKM2UI2FH6WYUKOUU: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // stake: USDC-VCHF pool
  CBUS3GWDBJYOLYC7PA3JCFQPPHXCX7U3TBHQSVCSTSNG6GH6WU4L74UE: { protocolName: 'phoenix_defi_hub', category: 'amm_liquidity' }, // stake: PHO-USDC pool

  // --- Soroswap (AMM) — #13 by TVL (~$1.2m) ---
  // https://github.com/soroswap/core/blob/main/public/mainnet.contracts.json
  // IMPORTANT CAVEAT, now confirmed rather than assumed: DefiLlama's own
  // Soroswap adapter enumerates pools on-chain by calling the factory's
  // all_pairs_length() + all_pairs(i), then reads each pair's token_0/
  // token_1/get_reserves directly - proving pairs are separate contracts.
  // Swap/liquidity events fire from those pair contracts, not from the
  // factory or router below. Use the same all_pairs_length/all_pairs calls
  // to enumerate real pair addresses before this will catch any trades.
  // https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/soroswap/index.js
  CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2: { protocolName: 'soroswap', category: 'amm_factory' },
  CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH: { protocolName: 'soroswap', category: 'amm_router' },

  // --- Defa by InvoiceMate (RWA, invoice financing) — #11 by TVL (~$4m) ---
  // RESOLVED, definitively, same method as Huma above: checked its ENTIRE
  // event history (30 events total, all of it). Every single one is
  // `new_contract_admin` - an admin-key-rotation event. Zero user-facing
  // invoice-financing events, ever. Same conclusion as Huma: this is
  // architectural (DefiLlama's own adapter reads it via a single
  // get_active_tvl() call to what it calls a "TVL Logger" contract, which
  // matches exactly), not something more data or a parser fix resolves.
  // https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/defa/index.js
  CDVVH3KWXWLVUO5OLLBBZSCZICV46PDKYA2G2HYBTWH4A6EJWTBRIXRK: { protocolName: 'defa_invoicemate', category: 'rwa_trade_finance' },

  // --- Peridot (lending) — #18 by TVL (~$44k), verified end-to-end ---
  // Not in the original spec. Real ReceiptVault contracts per asset (XLM/
  // USDC/EURC), each custodying its own SAC and debt ledger - this is the
  // most thoroughly verified entry in this file: I pulled real `mint` events
  // from mainnet, decoded them with this exact parser's logic, and confirmed
  // both the user address and amount come out correctly. Its `mint`/`redeem`
  // events carry their amount in a *map* ({amount: i128}), not a vec - this
  // shape is why xdrParser.ts now handles scvMap data payloads, not just
  // scvVec and bare scalars.
  // https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/peridot/index.js
  CBU4Y7CJFOUZZE3QBOXTKM54UTUYW3SDJWTNMDGJBNCR5HS5UCEKV3BE: { protocolName: 'peridot', category: 'lending_debt', defaultAssetCode: 'XLM' },
  CBVUJJIJTRJNOORPPCVH72DP7YDCOMDHI6WYKP3WOFVEPSCVP3TBXHIN: { protocolName: 'peridot', category: 'lending_debt', defaultAssetCode: 'USDC' },
  CD3WN3PLW63HFZXE56OTRLMBV46WG54TFPGRL4RDQ43HQTTWVB4RPO3G: { protocolName: 'peridot', category: 'lending_debt', defaultAssetCode: 'EURC' },

  // --- XOXNO Lending (lending, incl. tokenized RWAs like gold/T-bills) — #19 by TVL (~$40k) ---
  // A correction to an earlier pass: I had dismissed "Xoxno" entirely as
  // belonging only to a different chain (MultiversX, where its NFT
  // marketplace lives). That NFT marketplace claim is still true, but XOXNO
  // separately runs a small real lending hub on Stellar too - confirmed
  // live via their own public market-list API
  // (https://api.xoxno.com/integrations/lending/stellar), which currently
  // lists markets for XLM, USDC, EURC, AQUA and several RWA tokens (XAUM
  // tokenized gold, CETES/USTRY tokenized T-bills) all through this one
  // shared hub contract.
  // RESOLVED, definitively, same method as Huma/Defa above: checked all 200
  // most recent events (of an available ~371 total). Every one is
  // `market/batch_state_update`, `market/batch_params_update`, or
  // `strategy/fee` - purely system/accounting bookkeeping. Zero user-facing
  // supply/borrow/withdraw/repay events anywhere. Same conclusion as Huma
  // and Defa: the real per-user balances live in contract storage (which is
  // how their own API populates tvlUsd/suppliedUsd/borrowedUsd per market),
  // not in emitted events - this indexer's event-based architecture cannot
  // capture XOXNO's activity regardless of data availability.
  CBXRNDQMAJFG4VUKMKFEMFS75UUXE2SPSNV4LEEFCSNBCN66PYRWBKXO: { protocolName: 'xoxno_lending', category: 'lending_debt' },

  // --- Real-world-asset tokens (Stellar Asset Contracts) ---
  // CORRECTION to an earlier pass, which claimed classic Stellar assets
  // (VNX's tokens, specifically) "have no C... address and don't fit this
  // pipeline at all." That's wrong: every classic Stellar asset gets an
  // automatic, deterministic Soroban wrapper - its Stellar Asset Contract
  // (SAC), derived from `Asset.contractId(Networks.PUBLIC)` - and DeFi
  // protocols that move the asset via Soroban (swaps, lending, vaults) call
  // through that SAC, which DOES emit real transfer/mint/burn/clawback
  // ContractEvents. The classic peer-to-peer Payment operation does not
  // (that really is invisible to this indexer, and is the part the earlier
  // note was half-right about) - but SAC-routed activity is real, capturable
  // Soroban event data, confirmed on real assets below via Horizon's own
  // `contract_id` field and `num_contracts` (Soroban usage) figures.
  //
  // IMPORTANT SECURITY FINDING from this research: Stellar asset CODES have
  // no namespace protection - anyone can issue a classic asset called
  // "BENJI" or "USTRY" or "SPX". Querying Horizon by ticker alone surfaced
  // this concretely: searching "BENJI" returns Franklin Templeton's real
  // fund AND multiple obvious impersonators (issuers with tomls at
  // "franklintempleton.hqlumens.com", "franklintempleton.co.com",
  // "franklintempleton.lobstrhq.org" - subdomain/fake-TLD tricks, not
  // Franklin Templeton's real domain at all), some minting comically large
  // fake balances (640 billion+ units) to look legitimate. The only safe way
  // to identify a real RWA issuer found this session: verify the `.toml`
  // link's domain is EXACTLY that institution's known, real domain (not
  // "contains" the institution's name), and cross-check the balance against
  // an independent source (rwa.xyz's own reported total, here). Every entry
  // below passed both checks; this was not exhaustively done for the rest of
  // rwa.xyz's 97 tracked Stellar RWA assets - see README for what's covered.
  // KNOWN LIMITATION, confirmed on a real transfer event: a classic-asset
  // SAC `transfer` has TWO parties (from, to), both real account addresses -
  // findUserAddress takes the first one it finds (the sender, at topics[1]),
  // so the receiver is currently dropped entirely. Fine for lending/vault
  // events (only one real party), not fine if you need both sides of an RWA
  // transfer - would need a protocol-aware exception (SAC `transfer`
  // specifically) to capture both, not built yet.
  CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP: { protocolName: 'ondo_usdy', category: 'rwa_treasury' }, // Ondo USDY - toml at ondo.finance, $536M per rwa.xyz, 48 Soroban contracts hold real balances
  CCDSDPD7FXB74PFB2SYCHGQRWLXQRYRTQSPCVSRJ7FAOLOUGWEYAXQ7A: { protocolName: 'franklin_templeton_benji', category: 'rwa_treasury' }, // Franklin Templeton BENJI - toml at franklintempleton.com (not an impersonator), balance ($435.2M) matches rwa.xyz's reported $434.9M almost exactly

  // --- Spiko — #1 RWA platform on Stellar by AUM ($1.63B, bigger than Ondo) ---
  // Not found via the risky ticker-search method (that's exactly the method
  // that surfaced the squatting problem above) - found via DefiLlama's own
  // maintained adapter instead (projects/spiko/index.js), which reads these
  // exact 9 addresses' totalSupply from raw contract storage. Two of them
  // independently cross-confirmed against the truncated addresses visible on
  // rwa.xyz's own table (eurSAFO's "CBOOC...JX7FZP", gbpSAFO's
  // "CAGYR...KUNQKP") - two unrelated sources agreeing exactly. Real live
  // `transfer` events confirmed on EUTBL specifically; the other 8 weren't
  // individually event-checked but come from the same trusted source.
  CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO: { protocolName: 'spiko', category: 'rwa_treasury' }, // USTBL
  CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF: { protocolName: 'spiko', category: 'rwa_treasury' }, // EUTBL - verified live transfer event
  CDT3KU6TQZNOHKNOHNAFFDQZDURVC3MSTL4ML7TUTZGNOPBZCLABP4FR: { protocolName: 'spiko', category: 'rwa_treasury' }, // UKTBL
  CDS2GCAQTNQINSCJUJIVBJXILKBWP5PU7LOBGHMP3X47QCQBFKPMTCNT: { protocolName: 'spiko', category: 'rwa_treasury' }, // SPKCC
  CDWOB6T7SVSMMQN5V3P2OPTBAXOP7DAZHGVW3PYTZIKHVFKN6TBSXR6A: { protocolName: 'spiko', category: 'rwa_treasury' }, // eurSPKCC
  CDGSC6BA4TCAOVSFQCUEHDMOIIHYYVNYBT6YEARS4MX3ITAHUINVGQHX: { protocolName: 'spiko', category: 'rwa_treasury' }, // SAFO
  CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP: { protocolName: 'spiko', category: 'rwa_treasury' }, // eurSAFO - single largest RWA asset on Stellar (~$1.1B)
  CAGYRRKPFSWKM6SJOE4QAAVYMOSHMDS5WOQ4T5A2E6XNCU7LZZKUNQKP: { protocolName: 'spiko', category: 'rwa_treasury' }, // gbpSAFO
  CAJD2IBSP7VO2VYJQUYJSOGPJINTUYV7MQITINXVPTIH3CCLCUENNMW4: { protocolName: 'spiko', category: 'rwa_treasury' }, // chfSAFO

  // --- WisdomTree (9 funds, real per DefiLlama's adapter, quiet in live events) ---
  // Classic-asset code+issuer pairs from projects/wisdomtree/index.js, SAC
  // addresses derived via Asset.contractId() - SPXU's matched Horizon's
  // directly-reported contract_id exactly, confirming the derivation is
  // correct for the rest too. toml verified at stellar.wisdomtree.com (their
  // real domain). CAVEAT: zero events found across all 9 in RPC's live
  // retention window - real nonzero balances exist per Horizon (so these
  // aren't dead/fake), just no recent transfer activity observed; unlike
  // Spiko/Etherfuse this set has NOT been confirmed to emit capturable
  // events, only confirmed to exist and hold real value.
  CCDI4CNUSRI2UYQ2F44VVUB47WNYQL552SQLL5KT6JQHDTTOS4PAWQ5G: { protocolName: 'wisdomtree', category: 'rwa_treasury' }, // WTGX
  CCZ6ZWEO3KEA6PHTK56C6MEOHPVPBWZ7C3YUXR6SMBROPIEVXWICRY2L: { protocolName: 'wisdomtree', category: 'rwa_treasury' }, // FLTT
  CATVJYIVZMI3FFCFLNNBUSR7UGLIOCMJRZJ5YZU4LOVWKPTC4VSQ2IQG: { protocolName: 'wisdomtree', category: 'rwa_treasury' }, // WTSY
  CBZ63YIHU3OOSP2JW3CHMXJ67T3Z3IU3NRSSJ4M53GFDIRR4YXKCEE36: { protocolName: 'wisdomtree', category: 'rwa_treasury' }, // WTTS
  CC5XKPSET6QVWPL7EFUA7KXO6XLWPWXJKAGJC24MXW7EYVXQLUBV4OM5: { protocolName: 'wisdomtree', category: 'rwa_treasury' }, // TIPS
  CACJVBOTJ22N224NILIACP6FM75XE5JXIV2PGWYIXJ5R3GW3YD5VVFVS: { protocolName: 'wisdomtree', category: 'rwa_treasury' }, // WTST
  CAIDESHFY4QU4I7FNNROV2ADPFZCWMB3VDMLBT5DZYEKWGOLT4ODNS6I: { protocolName: 'wisdomtree', category: 'rwa_treasury' }, // WTLG
  CBVCBEMVSVH73W7HZZHEMFYSYNF2ALRUFNSATHF2WXENW33BGF5FSTFR: { protocolName: 'wisdomtree', category: 'rwa_treasury' }, // SPXU - matches Horizon's own contract_id field exactly
  CBBIDGSNGX43W6AEN32UFSLRTSM64MLNCXAHFCJV6PQYR5E6LV4IHPSS: { protocolName: 'wisdomtree', category: 'rwa_treasury' }, // WTSI

  // --- Etherfuse (4 assets, verified live and active) ---
  // Classic-asset issuer from projects/etherfuse/index.js's own Stellar
  // config, all 4 under one issuer. toml verified at etherfuse.com exactly
  // (their real domain). USTRY's derived SAC matched Horizon's own
  // contract_id field exactly. 200+ real live events found (hit the query
  // limit - genuinely active, not just held). Same issuer/CETES referenced
  // earlier in Templar's own vault manifest as a supported RWA asset -
  // independent cross-confirmation.
  CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV: { protocolName: 'etherfuse', category: 'rwa_treasury' }, // CETES
  CCHXOH2JGL6KBO5VOHR6WD4ZQXI6CFMJ5F65XVSZ6P47Y7KVZSQIPN6J: { protocolName: 'etherfuse', category: 'rwa_treasury' }, // EUROB
  CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS: { protocolName: 'etherfuse', category: 'rwa_treasury' }, // TESOURO
  CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR: { protocolName: 'etherfuse', category: 'rwa_treasury' }, // USTRY - verified 200+ live events, matches Horizon's contract_id exactly

  // --- Untangled RWA (~$151k TVL) — resolved, real Soroban vault found ---
  // DefiLlama's `untangled-curator` adapter (projects/untangled-curator/
  // index.js) names the real contract directly: a Soroban ERC4626-style
  // "Curator Vault" reading `total_assets()` for TVL. Checked its ENTIRE
  // on-chain event history via stellar.expert (59 events total, well past
  // Soroban RPC's now much shorter live retention window - see README) and
  // ran all of them through this exact parser: 57/59 (97%) produce real
  // `deposit`/`mint`/`withdraw` rows with real user addresses and amounts;
  // the 2 dropped are contract-mediated (same documented pattern as
  // Aquarius/Phoenix's aggregator-routed swaps - no real person's address
  // in the event). Unlike Huma/Defa/XOXNO, this one is genuinely
  // event-based and capturable, not view-function-only.
  CDDDLSQAR6EVIBFU6KMHA6WLIZJ5PDPXKJCEADD6YJ3HJ3S775XHVEE4: { protocolName: 'untangled_rwa', category: 'rwa_credit' },

  // The other three vaults listed on stellar.untangled.finance (found by opening
  // each vault page, 2026-10-03). Same product family but a different contract
  // build (wasm adf28ca3...) with its own event vocabulary - vault_initialized /
  // vault_deposit / vault_redeem_request / vault_claim_request / vault_setle_epoch,
  // depositor address in topics[1] - which the generic parser already reads.
  // Alpine x Gami AGUSD:
  CD4LFLCBS6LOLYTRRXICJEFZ3A3RTSFT2SJV5QQXKFJGMGNWQQ4ALMNV: { protocolName: 'untangled_rwa', category: 'rwa_credit' },
  // Indentura DENT1:
  CADEVOLEC3EX47EF6YBXVJ7DE6W7Z67BN55I5XQWX7GGSFHHOLHO2RQC: { protocolName: 'untangled_rwa', category: 'rwa_credit' },
  // Alpine x Gami AGXLM:
  CBNAVFEOOVCRUELW2RTQU3KY2NJUF7GWBZI2UYYSZFJJ22LCR2VORS3B: { protocolName: 'untangled_rwa', category: 'rwa_credit' },

  // --- Alula (lending w/ looping) — found via stellar.org's ecosystem
  // directory, not DefiLlama (no adapter there yet) ---
  // Real, actively developed, professionally audited (Halborn, Highland
  // Security) Soroban lending protocol - github.com/pointgroup-labs/alula.
  // The live app itself misleadingly shows "$0 deposits, no markets", but
  // that's just the UI's default/empty state: the real Market contract
  // address isn't in any public API or docs, so it was extracted directly
  // from the frontend's own minified JS bundle (app.alula.finance's _nuxt/
  // *.js), then independently confirmed real via stellar.expert - 167
  // real events, all real mainnet XLM/USDC SACs. The MarketManager
  // contract that deployed it has no on-chain "list all markets" function
  // (checked its real public interface on GitHub) - deploy events are the
  // only enumeration path, and the manager's own event count is 0, so this
  // is registered as the one market confirmed live rather than discovered
  // programmatically; revisit if Alula ships more markets.
  // Needed genuinely new parser support, not just a registry entry: every
  // core event's real amount sits two map levels deep (e.g. `deposit_event`
  // -> `{deposit_result: {deposited: i128, ...}}`), past what the generic
  // one-level flattenOneLevel reaches - see resolveAlulaAmount/
  // resolveAlulaAsset in xdrParser.ts. Ran all 167 real events through the
  // real parser after that fix: 138/167 (83%) parsed, all 7 real
  // lending/credit event types (deposit/borrow/withdraw/repay/liquidate/
  // add_collateral/remove_collateral - 114 of those 138) verified correct
  // amount+asset against the raw event data by hand; the rest are
  // admin/governance events correctly dropped (no real user address).
  CBP76I2FRMUKYKIYYBKN3DH7TSWMFAJF2WTDC7Q2OHQFBIVWP7CAAI5Q: { protocolName: 'alula', category: 'lending_pool' },

  // --- Slender (money market) — found via stellar.org's ecosystem
  // directory; real DefiLlama adapter confirmed the pool address ---
  // github.com/eq-lab/slender. Noncustodial overcollateralized lending,
  // Blend-style: per-reserve sToken/debt-token accounting for XLM/XRP/USDC.
  // Tiny current TVL (~$97 per DefiLlama) but genuinely live since 2024.
  // No new parser code needed at all - its deposit/withdraw/borrow/repay
  // events already match the exact shape the generic parser was built for
  // (`[event_name, user_account]` topics, `[asset_contract, amount]` data).
  // Ran its full real event history (224 events, stellar.expert) through
  // the real parser: 217/224 (97%) parsed, all 4 core event types verified
  // correct amount+asset by hand against the raw data; the 7 dropped are
  // reserve-config/admin events with no real user address.
  CCL2KTHYOVMNNOFDT7PEAHACUBYVFLRH2LYWVQB6IPMHHAVUBC7ZUUC2: { protocolName: 'slender', category: 'lending_pool' },

  // --- Normal (wrapped-asset vaults for institutions) — found via
  // stellar.org's ecosystem directory; real DefiLlama adapter confirmed
  // the factory address ---
  // Turns custodied tokens into yield-generating wrapped "Normal Tokens"
  // via per-asset pair contracts (BTC/XRP/ETH/ADA seen live), deployed from
  // one factory. $0 TVL per DefiLlama right now, but genuinely active:
  // user-facing `mint`/`redeem` activity is emitted directly by the
  // FACTORY contract itself (confirmed - the individual pair contracts'
  // own events are all admin/upgrade-only, checked directly), so
  // registering just the factory catches all of it; no per-pair discovery
  // needed. Needed small parser fixes, not just a registry entry: `mint`'s
  // real amount sits at data-vec index 1 behind an always-zero reserved
  // field (the generic "first numeric value" picks the zero instead), and
  // both `mint`/`redeem` carry their timestamp as a plain scvU64 that the
  // generic numeric-type filter doesn't exclude the way it does
  // scvTimepoint - see resolveNormalAmount/resolveNormalAsset in
  // xdrParser.ts (the latter also reads the real BTC/XRP/... ticker
  // straight off its own topic instead of leaving assetCode empty). Ran
  // its full real event history (45 events, stellar.expert) through the
  // real parser after that fix: 40/45 (89%) parsed, both real event types
  // (33 mint + 1 redeem) verified correct amount+ticker by hand; the rest
  // are factory-admin/pair-deploy events correctly dropped or low-value.
  CD5LOWLRQXTG5ZTNU4NA4NNLGGKNRJNRX45PVINVY7VCTOFQAAOYLTF5: { protocolName: 'normal', category: 'wrapped_asset' },

  // --- Fundable (Merkle-drop mass distribution) — found via a direct user
  // link, not DefiLlama (too new/small to be tracked there) ---
  // Real company (fundable.finance - "programmable finance infrastructure":
  // mass distribution, payroll, streaming, offramp). This one contract is a
  // Merkle-drop claim module: an admin calls `create_distribution(asset,
  // total_amount, merkle_root, ...)`, funding a pool that individual
  // claimants later withdraw their allotted share of via `claim(claimant,
  // distribution_id, amount, proof)` against that root. Created 2026-09-28
  // (brand new) by GDZJSPRSBTAJPAQ4NG6Y2ZCWHEX5HMS253TYVNAQJRPJHY27JPOHBIPZ;
  // at registration time had exactly 1 real distribution (40 XLM) and 2 real
  // distinct claimants (2 XLM each) - genuine activity, just very early.
  // Could NOT enumerate other Fundable contracts: stellar.expert's public API
  // silently ignores both its `creator` and `wasm` query params (verified -
  // they return an unrelated, unfiltered contract list, not a real filter),
  // and there's no dedicated "other instances of this wasm hash" page either.
  // So this registry entry may not be Fundable's only mainnet contract if
  // they later split payroll/streaming into separate deployments - revisit
  // if their site's claimed scale ($100k+ transacted) doesn't show up here.
  // CATEGORY IS A DELIBERATE CHOICE, not a TVL-style DeFi category: a claim
  // event is a one-time receipt of an already-earned/allocated distribution,
  // not repayment or collateral behavior - weaker as a credit signal than
  // lending/AMM/yield activity, but still real wallet-level financial
  // activity worth having.
  // NEEDED PARSER SUPPORT: both `claim` and `distribution_created` carry the
  // distribution_id as a second numeric TOPIC, which the generic amount
  // picker was flattening in alongside the real data-vec amount and picking
  // wrong (same class of bug as Normal's mint/redeem) - see
  // resolveFundableAmount in xdrParser.ts. `claim`'s own event data has no
  // asset address at all (only `distribution_created` does), so
  // defaultAssetCode below is inferred from the one real distribution seen
  // so far (XLM) - would be wrong if a future distribution uses a different
  // asset; there is no way to attribute a specific claim to its
  // distribution's real asset without correlating back to that
  // distribution's own `distribution_created` event, not built here.
  CD6G3UTDV4XPDMVNYTPQ6UCL7FWSYG5LXYAZXBDDSKY5YOQ6HLDBPYRY: { protocolName: 'fundable', category: 'mass_distribution', defaultAssetCode: 'XLM' }

  // --- Left out on purpose ---
  // See README.md's "Registry research notes" for the full list and why:
  // Lucent/YieldAmp (no evidence of existing on Stellar under these names,
  // and absent from DefiLlama's 39 tracked Stellar protocols too); Excellar
  // (real per DefiLlama's own rankings, ~$184k TVL - now DEFINITIVELY
  // confirmed architecturally out of scope: its own adapter,
  // projects/excellar/index.js, reads a plain Horizon account's classic
  // USDC balance by G-address - not a Soroban contract at all, same "no
  // C... address" issue as Stellar DEX/AMM below); Realiz's VuMe Bond 2030
  // (real, ~$500M, ticker TPT30 per rwa.xyz/assets/TPT30 and independently
  // confirmed via press coverage of the TPT Global Tech/Realiz partnership -
  // but genuinely no discoverable contract address: zero results on Horizon
  // (no classic asset with this code), zero on stellar.expert's asset
  // search and directory, and no address in any TPT Global Tech/Realiz
  // press material found. Not in DefiLlama at all either. Would need the
  // address from Realiz/rwa.xyz directly - not something to guess at);
  // Matrixdock (checked three ways: DefiLlama's protocol API shows zero
  // Stellar chain TVL across all 3 of its tracked products - STBT/XAUM/
  // XAGM are Ethereum/Plume/BSC/Sui/Solana only; its own DefiLlama adapter
  // source has no Stellar entry; and the current rwa.xyz Stellar league
  // table's top 10 platforms don't include it at all. The "~$4.6M, 2.94%
  // utilization" figure referenced when this was first flagged doesn't
  // reproduce from any of these three sources today - treat that figure as
  // unconfirmed rather than pursue an address for it); Stellar DEX / Stellar
  // AMM entries on DefiLlama (confirmed via their own adapters to be classic
  // ledger balance snapshots, not Soroban contracts either - same "no
  // C... address" issue as Stellar's native AMM from the original spec);
  // Lantern Finance (real, but a San Francisco CeFi crypto-backed-loan
  // company - BitGo custody, MSB/FinCEN-registered - that merely accepts
  // XLM as one of nine collateral currencies through traditional custodial
  // lending, not Soroban; confirmed via their own site and press coverage,
  // no DefiLlama entry either); Balanced (real, and DefiLlama does list a
  // Stellar chain for it - but its own adapter source shows why: it reads
  // `getAssetDeposit` on its ICON-hosted asset-manager contract, i.e. a
  // bridge-deposit balance tracked on ICON's side, not any Soroban
  // contract's own state - same "no real Stellar-side contract to read
  // events from" issue as Excellar, just via a bridge instead of a plain
  // balance check).
};
