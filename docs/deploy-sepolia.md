# Deploying to Sepolia

Everything in this file is a real transaction on a real, if worthless, network. Nothing here
touches a private key on the assistant's behalf — every `--account`/`--broadcast` step is one you
run yourself, from your own keystore. What follows is the order that works and the reasons for it,
so a rerun after a mistake does not mean starting over.

## Before any of this

- **Sepolia ETH.** The real deployment on 2026-10-06 used 8.05 million gas in all — Deploy 4.53M,
  RegisterSchema 1.19M, Smoke 2.33M — about 0.0089 ETH at that day's 1.1 gwei, plus 0.0008 for one
  smoke run that ran out of gas (step 3). A few hundredths of an ETH is plenty unless Sepolia's gas
  price spikes. The smoke test also deposits 0.00002 ETH into a vault it creates for you, where it
  stays — yours, and recoverable, as step 3 explains. Faucets, as checked on 2026-10-06: the one at
  [cloud.google.com/application/web3/faucet/ethereum/sepolia](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)
  gives 0.05 but may ask that the receiving address hold 0.001 ETH on mainnet, which a new address
  does not; [sepolia-faucet.pk910.de](https://sepolia-faucet.pk910.de) asks for nothing but some
  minutes of in-browser mining.
- **A keystore, not a raw key.** `.env.example` already says this and it is worth repeating: this
  repo's scripts are written to take `--account <name>`, never `--private-key`. The simplest is a
  new address used only for deploying, whose key is generated encrypted and never shown:

  ```bash
  cast wallet new truesend-deployer
  ```

  Choose a password; it prints the address to fund. (To use a key you already hold instead:
  `cast wallet import truesend-deployer --interactive`.) Either way the key is encrypted under
  `~/.foundry/keystores/`, and every command below uses `--account truesend-deployer`.
- **A Sepolia RPC.** `.env.example`'s default, `https://ethereum-sepolia-rpc.publicnode.com`, works
  but on some networks drops connections with `tls handshake eof`; on 2026-10-06 the deployment
  finished through `https://sepolia.gateway.tenderly.co` after publicnode had dropped twice. If a
  command fails with a connection error, rerun it or switch endpoint — it is not the contract.
- **Optionally, an Etherscan API key**, free, from [etherscan.io/apis](https://etherscan.io/apis), to
  publish verified source with `--verify`. Put it in `ETHERSCAN_API_KEY` in your shell environment
  (or a local, gitignored `.env` you source — never commit one). The 2026-10-06 deployment went
  without it, so its source is not yet verified on Etherscan.
- From `contracts/`, with Foundry on your `PATH`:
  ```bash
  export PATH="$PWD/../.tools/foundry:$PATH"   # if using the copy vendored in this repo
  export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
  export ETHERSCAN_API_KEY=<your key>
  ```

## 0. Rehearse it first: one command, free

From the repository root:

```bash
node tools/rehearse-sepolia.mjs
```

It runs steps 1–3 below, with the same flags, against a private copy of Sepolia on your own
machine, then prints `PASSED` and what the real deployment costs at Sepolia's gas price right now.
Nothing is sent to Sepolia, no key or ETH of yours is used, and nothing in this repository is
written. It takes about half a minute. If it does not say `PASSED`, do not go on to step 1.

What it does, for anyone checking: forks Sepolia with `anvil`, runs the three scripts from a freshly
generated keystore account funded on the fork only, in a temporary copy of `contracts/` — so the
deployment files they write, which would otherwise look exactly like a real Sepolia record, can
never be committed — and deletes the copy and stops the fork afterwards. It needs Foundry and the
contract libraries (`git submodule update --init`), not `pnpm install`.

Two differences from the real run it cannot remove, and each has already hidden a real failure:

- **The password.** It passes it with `--password`, because a script cannot type into forge's
  prompt, and that changes who `msg.sender` is inside a script. The scripts no longer depend on it.
- **The gas schedule.** The fork charges gas by the rules forge knows (`prague`), not Sepolia's
  current ones, so it passed a smoke test that then ran out of gas on the real chain (step 3). It
  now runs Smoke with the margin that real chain needs, and its cost figure is the real
  deployment's measured gas, not the fork's.

A pass still means the EAS addresses hard-coded in `RegisterSchema.s.sol` are live on Sepolia —
Smoke's attestation goes through them. What a fork cannot rehearse at all: Etherscan verification
(`--verify` needs your API key and a real deployment), and anything about your own key, keystore or
balance.

## 1. Deploy the singletons

```bash
forge script script/Deploy.s.sol \
  --account truesend-deployer --rpc-url sepolia \
  --broadcast --verify
```

Deploys `GuardedAccount`, `SafeVault` and `SafeVaultFactory` — once each, ever, for the whole
network; see the doc comment on `Deploy.s.sol` for why a single deployment serves every user.
Writes `deployments/11155111.json`. `--verify` submits to Etherscan in the same run using the
`[etherscan]` table already in `foundry.toml`; if it times out (Etherscan's indexer lagging behind
a fresh deployment is common), rerun with just `--resume --verify` rather than the whole script —
that resumes verification against the already-broadcast transactions instead of deploying a second
copy of everything.

**Commit `deployments/11155111.json`.** Unlike the `31337.json` from a local `anvil` run — which
resets every time you restart anvil and is gitignored for exactly that reason — this is a public,
permanent deployment record, and the web app reads it from the repo rather than from anything
hand-copied.

## 2. Deploy the community registry

```bash
forge script script/RegisterSchema.s.sol \
  --account truesend-deployer --rpc-url sepolia \
  --broadcast --verify
```

EAS itself is already on Sepolia — `RegisterSchema.s.sol` only deploys `PoisonRegistry` and
registers the schema against it, using EAS addresses the script confirms on chain rather than
takes on faith (see the doc comment for how). Writes `deployments/registry-11155111.json`.
**Commit this one too**, same reasoning as step 1.

## 3. Prove it, not just that it compiled

```bash
forge script script/Smoke.s.sol \
  --account truesend-deployer --rpc-url sepolia \
  --broadcast --slow -g 1000
```

`forge test` proves the logic once, in a controlled EVM. It does not prove that the bytecode at
*this* address, on *this* chain, right now, actually behaves that way — a wrong constructor
argument or a stale ABI would not show up in a test run against different bytecode. `Smoke.s.sol`
closes that gap: it deploys a real vault through the real factory, funds it, queues a payment,
confirms the deployed contract itself refuses to execute early, cancels, and submits both a true
and a false lookalike claim to the real registry through the real EAS. Read its doc comments before
running it: they say exactly what spends real value (0.00002 ETH, deposited from your address into
a vault only you control, plus gas) and what is only ever simulated, never broadcast (the claim that
is supposed to fail).

**What success looks like:** eight `[ok]` lines and `All smoke checks passed.`, *and then* every
transaction marked ✅ and `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`. The two are different claims.
The `[ok]` lines come from forge's simulation, before anything is sent; the ✅ lines are the chain's
answer. On Sepolia the first can pass while the second fails, which is what happened below. Anything
short of both means stop before step 4. (This said "nine `[ok]` lines" until 2026-10-06; the script
has always made eight checks, and a careful reader would have stopped a deployment that had
succeeded.)

**Why `--slow -g 1000`.** Sepolia's gas schedule has moved past the `prague` rules forge estimates
with (`evm_version` in `contracts/foundry.toml`; its blocks now carry a `blockAccessListHash`).
Measured on the real deployment on 2026-10-06: every transaction in steps 1 and 2 used no more than
forge estimated, but Smoke's calls that create a vault or write new storage used 3.2 to 4.2 times
as much — creating the vault 621,518 gas against an estimate of 148,320, queuing the payment 374,989
against 116,268, the attestation 1,271,639 against 347,871. With forge's default 30% margin, those
three ran out of gas on chain while the simulation printed eight `[ok]`. `-g 1000` sets each limit
to ten times forge's estimate; you pay only for gas used, about 0.0027 ETH for the whole step that
day. `--slow` sends each transaction only after the previous one succeeded, so a failure stops the
run instead of sending the rest against a vault that does not exist.

**This step has failed three times, each one a different lesson:**
- against a fresh local deployment, with `InvalidGuardian()`: the script passed the wrong guardian
  argument. That failure is the point of a script that touches deployed bytecode rather than
  trusting that `Deploy.s.sol` finishing without error means everything downstream is wired;
- on the first real Sepolia run, with `Unauthorized()`, after every rehearsal had passed: the script
  took `msg.sender` to be the deployer, and with the password typed at forge's prompt `msg.sender`
  is forge's default address. Nothing was sent; forge simulates first. The script now reads the
  signing account from inside a broadcast, and CI fails any deploy script that reads `msg.sender`;
- on the second, out of gas, for the reason above. That one did reach the chain: five transactions,
  about 0.0008 ETH of gas, nothing else — the failed transfer kept its value, and the vault and the
  attestation were never created.

Steps 1 and 2 never needed repeating: neither depends on its caller, and neither creates storage the
way Smoke does.

## 4. Wire the addresses into the app

Commit `contracts/deployments/11155111.json` and `registry-11155111.json` and push. That is the
whole step for the live demo: its build reads the addresses from those two records
(`tools/deployment-env.mjs`, run by `.github/workflows/pages.yml`), so nothing is copied by hand.

For a local dev server, the same script writes them into the app's environment:

```bash
node tools/deployment-env.mjs >> apps/web/.env.local
```

(EAS's own address needs no variable — `packages/chain/src/registry.ts` already has it for Sepolia —
and neither does the schema UID, which the app derives from the registry's address and checks
against the chain's schema registry.)

Choose Sepolia on the Send screen and enter a vault address — the smoke test's own vault will do —
and it reads a real policy instead of saying there is none; the Report screen says "Registry live on
this chain".

## 5. The one thing the smoke test cannot check

`Smoke.s.sol` verifies `SafeVault` and `PoisonRegistry` end to end because both are ordinary
contracts a script can call. It does **not** exercise `GuardedAccount`'s delegation path, because
that needs a live EOA signing an EIP-7702 authorization tuple in its own wallet — not something a
deploy script should ever be doing on someone's behalf, scripted or not.

Check it by hand, once, from your own keystore with `cast`. **There is no button for this in the
app** — this section used to say "follow the prompt on the Send screen", and no such prompt was ever
built; browser wallets also generally refuse to sign a 7702 authorization for a contract that is not
their own. The deployer account from step 1 will do, since it holds a little Sepolia ETH. From
`contracts/`, with `SEPOLIA_RPC_URL` set:

```bash
ME=<your deployer address>
GUARDED=<guardedAccountImplementation from deployments/11155111.json>
```

1. Delegate to `GuardedAccount` and switch the policy on, in one transaction — the authorization and
   the `initialize` self-call land together, which is what stops anyone else initialising it first:

   ```bash
   cast send $ME "initialize(uint32,uint32,address)" 300 300 0x0000000000000000000000000000000000000000 \
     --auth $GUARDED --account truesend-deployer --rpc-url $SEPOLIA_RPC_URL
   ```

   `cast` warns that a signed authorization can be submitted by anyone once sent, and asks to
   continue; answer `y`. Here that is safe by design: the authorization alone only installs the
   code, and only the account itself can call `initialize`. Afterwards `cast code $ME` prints
   `0xef0100` followed by `$GUARDED`.
2. Queue a small payment to an address this account has never paid — the smoke test's vault is a
   good choice, because it is yours:

   ```bash
   cast send $ME "send(address,address,uint256)" <vault address> 0x0000000000000000000000000000000000000000 100000000000000 \
     --account truesend-deployer --rpc-url $SEPOLIA_RPC_URL
   ```

   It queues instead of settling. The first queued transfer is id **1** — ids start at 1, because
   `send` returns 0 for a transfer that settled at once. (This section used to say id 0, and
   `executeQueued(0)` reverts with `TransferNotQueued`: a revert, but not the one that proves
   anything.) The live demo's Pending screen, on Sepolia with `$ME` as the protected account, shows
   it waiting.
3. Try to execute it early. A call, not a transaction, so it costs nothing:

   ```bash
   cast call $ME "executeQueued(uint256)" 1 --from $ME --rpc-url $SEPOLIA_RPC_URL
   ```

   It must revert with error `0x10995f9c` — `TransferLocked(uint64)`, carrying the unlock time.
4. Cancel it:

   ```bash
   cast send $ME "cancelQueued(uint256)" 1 --account truesend-deployer --rpc-url $SEPOLIA_RPC_URL
   ```

   `cast call $ME "getTransfer(uint256)((address,address,uint256,uint64,uint64,uint8))" 1` now ends
   in status `3`, cancelled, and Pending shows nothing waiting.

Rehearsed on a fork of Sepolia on 2026-10-07 with a throwaway keystore: every step behaved as
written, and the early execution reverted with exactly `TransferLocked(unlockAt)`. The delegated
account still signs ordinary transactions with its key as before; delegating to
`0x0000000000000000000000000000000000000000` removes the code again.

**Done on Sepolia the same day**, from the deployer account
`0x816C8ecE6D775a1E8FA4540c57cB0A6b80B463C0`, with its password typed at the prompt: delegation and
`initialize` in one type-4 transaction (281,731 gas,
`0xe92c3fd33ef9ed4fbe7cb2239fbfb177b1243fe6cceab0bb1ef24acf9b350b00`, emitting `PolicyInitialized`
with a 300-second hold); transfer 1 queued (369,723 gas,
`0xb485be4e629e91959a9f24ea62ead21efeccbe4e35e2c6b40274a910904f87a3`); the early execution refused
with `TransferLocked(1791347256)`, that transfer's unlock time; cancelled (31,756 gas,
`0xc7d9556438b36c4f8ea80192cb8037470a0283044d1c6f50ae9f6ee86bbd96ac`). Read back from the chain
afterwards rather than taken from the terminal: the account's code is `0xef0100` followed by the
`GuardedAccount` address, `mode()` answers `GuardedAccount/7702`, and transfer 1 has status 3. Unlike
`forge script`, `cast send` takes its gas limit from the node's own estimate, so Sepolia's newer gas
schedule needed no margin here.

This is the step that matters for a demo of the 7702 path: it is the one place a live signature
meets a live contract, and it is the one path that should not be scripted on anyone's behalf.

## After deploying

Update the "Deployed on Sepolia" section of [`README.md`](../README.md) with the new addresses and
Etherscan links, so a viewer of the demo can check them independently. The deployment of
2026-10-06 is recorded there.

**Verifying the source afterwards**, if steps 1–2 ran without `--verify` (as on 2026-10-06). It
publishes nothing that is not already public in this repository and touches no funds. With
`ETHERSCAN_API_KEY` set, from `contracts/` — addresses from the two records, and the constructor
arguments are the vault template's address and EAS's, ABI-encoded:

```bash
forge verify-contract <guardedAccountImplementation> src/GuardedAccount.sol:GuardedAccount --chain sepolia --watch
forge verify-contract <safeVaultImplementation> src/SafeVault.sol:SafeVault --chain sepolia --watch
forge verify-contract <safeVaultFactory> src/SafeVaultFactory.sol:SafeVaultFactory --chain sepolia --watch \
  --constructor-args $(cast abi-encode "constructor(address)" <safeVaultImplementation>)
forge verify-contract <poisonRegistry> src/PoisonRegistry.sol:PoisonRegistry --chain sepolia --watch \
  --constructor-args $(cast abi-encode "constructor(address)" <eas>)
```

Checked before relying on it, on 2026-10-07: the runtime bytecode of all four deployed contracts is
identical to a local build except inside their immutable slots, and the request these commands
assemble carries the same compiler settings (0.8.28, optimizer 200, `prague`, no metadata hash).
Smoke's vault is an EIP-1167 clone, which Etherscan recognises without verification.
