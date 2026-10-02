import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { RabetModule } from "@creit.tech/stellar-wallets-kit/modules/rabet";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";

StellarWalletsKit.init({
  network: Networks.PUBLIC,
  modules: [
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
    new RabetModule(),
    new LobstrModule(),
    new HanaModule(),
  ],
});

export async function connectWallet(): Promise<string> {
  const { address } = await StellarWalletsKit.authModal();
  return address;
}

export async function disconnectWallet(): Promise<void> {
  await StellarWalletsKit.disconnect();
}

/**
 * Proves the connected wallet actually controls `address`, without ever
 * touching the network or costing anything: builds a throwaway transaction
 * (sequence number is irrelevant since it's never submitted), has the
 * wallet sign it, then verifies the signature client-side against the
 * claimed address. A plain transaction is used instead of SEP-53
 * signMessage() because every Stellar wallet implements signTransaction
 * consistently, while signMessage support/byte-semantics vary more across
 * extensions.
 */
export async function proveOwnership(address: string): Promise<boolean> {
  const nonce = Keypair.random().publicKey(); // cheap source of randomness, never used as a real key
  const dummyAccount = new Account(address, "0");
  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.manageData({
        name: "lucred-connect-proof",
        value: nonce.slice(0, 64),
      })
    )
    .setTimeout(300)
    .build();

  const { signedTxXdr } = await StellarWalletsKit.signTransaction(tx.toXDR(), {
    networkPassphrase: Networks.PUBLIC,
    address,
  });

  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, Networks.PUBLIC);
  if (!("source" in signedTx)) return false; // rules out FeeBumpTransaction
  return WebAuth.verifyTxSignedBy(signedTx, address);
}
