import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type FullySignedTransaction,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  type TransactionWithBlockhashLifetime,
} from "@solana/kit";

export async function createSignedTransaction(rpc: Rpc<SolanaRpcApi>, signer: TransactionSigner, instructions: Instruction[]) {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx)
  );
  return signTransactionMessageWithSigners(message);
}

export async function simulate(rpc: Rpc<SolanaRpcApi>, transaction: FullySignedTransaction) {
  const wire = getBase64EncodedWireTransaction(transaction);
  return rpc.simulateTransaction(wire, {
    commitment: "confirmed",
    encoding: "base64",
    sigVerify: true,
  }).send();
}

export async function sendAndConfirm(
  rpcUrl: string,
  rpc: Rpc<SolanaRpcApi>,
  transaction: FullySignedTransaction & TransactionWithBlockhashLifetime
): Promise<string> {
  const wsUrl = rpcUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const { createSolanaRpcSubscriptions } = await import("@solana/kit");
  const subscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sender = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subscriptions });
  const signature = getSignatureFromTransaction(transaction);
  await sender(transaction, { commitment: "confirmed", skipPreflight: false });
  return signature;
}
