# Deploying to Sepolia

Everything in this file is a real transaction on a real, if worthless, network. Nothing here
touches a private key on the assistant's behalf — every `--account`/`--broadcast` step is one you
run yourself, from your own keystore. What follows is the order that works and the reasons for it,
so a rerun after a mistake does not mean starting over.

## Before any of this

- **Sepolia ETH.** Measured, not guessed: on a fork of Sepolia on 2026-10-06 (step 0 below), the
  three scripts used about 8.3 million gas between them — Deploy 5.9M, RegisterSchema 1.6M, Smoke
  0.9M — which was about 0.009 ETH at that day's gas price of 1.1 gwei. A few hundredths of an ETH
  therefore covers everything with room to spare unless Sepolia's gas price spikes past a few
  gwei; check it with `cast gas-price --rpc-url sepolia` first if in doubt. The smoke test in step
  3 also deposits 0.00002 ETH into a vault it creates for you, where it stays — yours, and
  recoverable, as step 3 explains. Faucets: the one at
  [cloud.google.com/application/web3/faucet/ethereum/sepolia](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)
  and [sepoliafaucet.com](https://sepoliafaucet.com) both work without a mainnet balance
  requirement as of this writing; if a faucet asks for a mainnet balance you don't have, try the
  other.
- **A keystore, not a raw key.** `.env.example` already says this and it is worth repeating: this
  repo's scripts are written to take `--account <name>`, never `--private-key`. Set one up once:

  ```bash
  cast wallet import truesend-deployer --interactive
  ```

  Paste the private key when prompted, choose a password, and it is encrypted on disk under
  `~/.foundry/keystores/`. Every command below uses `--account truesend-deployer`.
- **An RPC that supports Prague.** Sepolia has been on the Prague fork (and therefore EIP-7702)
  since well before this project started; `.env.example`'s default,
  `https://ethereum-sepolia-rpc.publicnode.com`, is one such endpoint. If a command below fails
  with something that looks like "invalid transaction type" rather than a revert reason, the
  endpoint is the first thing to suspect, not the contract.
- **An Etherscan API key**, free, from [etherscan.io/apis](https://etherscan.io/apis) — the same
  key verifies contracts on Sepolia and mainnet. Put it in `ETHERSCAN_API_KEY` in your shell
  environment (or a local, gitignored `.env` you source — never commit one).
- From `contracts/`, with Foundry on your `PATH`:
  ```bash
  export PATH="$PWD/../.tools/foundry:$PATH"   # if using the copy vendored in this repo
  export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
  export ETHERSCAN_API_KEY=<your key>
  ```

## 0. Rehearse on a fork first (free, and nothing leaves your machine)

Every script below can be run against a local copy of Sepolia before any of it is run against
Sepolia itself. `anvil --fork-url` serves Sepolia's real state — including the real EAS contracts
step 2 registers against — from your own machine, and transactions sent to it go nowhere else. Its
built-in test accounts are funded and unlocked, so no key of yours is involved at all.

Do it in a throwaway clone. The scripts write `deployments/11155111.json` and
`deployments/registry-11155111.json` exactly as a real run does, and a fork keeps Sepolia's chain id,
so those files would look identical to a real deployment record — with addresses that exist nowhere
but your machine. In a separate clone they cannot be committed by mistake.

```bash
git clone . ../truesend-rehearsal && cd ../truesend-rehearsal
git -c core.longpaths=true submodule update --init   # long paths: Windows needs it, others ignore it
cd contracts
anvil --fork-url "$SEPOLIA_RPC_URL" --port 8547      # leave this running in another terminal
```

```bash
SENDER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266    # anvil's first test account, funded and unlocked
for s in Deploy RegisterSchema Smoke; do
  forge script script/$s.s.sol --rpc-url http://127.0.0.1:8547 --broadcast --unlocked --sender $SENDER || break
done
```

Last run on 2026-10-06 with Foundry 1.8.3, forked at Sepolia block 11,853,296: all three scripts
succeeded, Smoke printed its eight `[ok]` lines, and the EAS and SchemaRegistry addresses
hard-coded in `RegisterSchema.s.sol` had code on Sepolia, with `EAS.getSchemaRegistry()` returning
exactly the registry the script uses. What a fork cannot rehearse: Etherscan verification (`--verify`
needs your API key and a real deployment to point at), and anything about your own key, keystore or
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
  --broadcast
```

`forge test` proves the logic once, in a controlled EVM. It does not prove that the bytecode at
*this* address, on *this* chain, right now, actually behaves that way — a wrong constructor
argument or a stale ABI would not show up in a test run against different bytecode. `Smoke.s.sol`
closes that gap: it deploys a real vault through the real factory, funds it, queues a payment,
confirms the deployed contract itself refuses to execute early, cancels, and submits both a true
and a false lookalike claim to the real registry through the real EAS.

The first time this was run against a fresh local deployment, it failed with `InvalidGuardian()` —
the script itself had passed the wrong guardian argument. That failure is the point of having a
script that touches deployed bytecode rather than trusting that `Deploy.s.sol` finishing without
error means everything downstream is wired correctly. Read `contracts/script/Smoke.s.sol`'s doc
comments before running it; it explains exactly what spends real value (0.00002 ETH, deposited from
your address into a vault only you control, plus gas) and what is only ever simulated, never
broadcast (the claim that is supposed to fail).

Expect eight `[ok]` lines and `All smoke checks passed.` at the end. Anything else means stop before
step 4 — the addresses from steps 1–2 are not safe to wire into the app yet. (This said nine until
2026-10-06, from the day it was written; the script has always made eight checks. A careful reader
would have stopped a deployment that had succeeded.)

## 4. Wire the addresses into the app

```bash
cd apps/web
cp ../../.env.example .env.local   # if you have not already
```

From `contracts/deployments/11155111.json`:

```
NEXT_PUBLIC_SEPOLIA_VAULT_FACTORY=<safeVaultFactory>
NEXT_PUBLIC_SEPOLIA_GUARDED_ACCOUNT=<guardedAccountImplementation>
```

From `contracts/deployments/registry-11155111.json`:

```
NEXT_PUBLIC_SEPOLIA_POISON_REGISTRY=<poisonRegistry>
```

(EAS's own address needs no variable — `packages/chain/src/registry.ts` already has it for
Sepolia, confirmed on chain by `RegisterSchema.s.sol` rather than copied from documentation.)

```bash
corepack pnpm --filter @truesend/web build && corepack pnpm --filter @truesend/web start
```

or, for local iteration, `dev` instead of `build`+`start`. Switch your wallet to Sepolia and the
Send screen should now read a real policy instead of saying there is none.

## 5. The one thing the smoke test cannot check

`Smoke.s.sol` verifies `SafeVault` and `PoisonRegistry` end to end because both are ordinary
contracts a script can call. It does **not** exercise `GuardedAccount`'s delegation path, because
that needs a live EOA signing an EIP-7702 authorization tuple in its own wallet — not something a
deploy script should ever be doing on someone's behalf, scripted or not.

Check it by hand, once, with a wallet that supports sending EIP-7702 authorizations (a recent
MetaMask or Rabby) and an address holding a small amount of Sepolia ETH you don't mind tying up
for a few minutes:

1. Open the Send screen, pointed at Sepolia, connected as that address.
2. Follow the prompt to install the delegation. Your wallet will describe it as authorizing code
   at the `guardedAccountImplementation` address from step 1 — check that address matches before
   signing anything, the same way you would check any other authorization.
3. Send a small amount to an address you have never paid. It should queue, not settle.
4. Try to force an early execution — there is no button for this in the UI on purpose, so use
   `cast send $YOUR_ADDRESS 'executeQueued(uint256)' 0 --account truesend-deployer --rpc-url
   sepolia` (id `0` for the first transfer from a fresh delegation) — and confirm it reverts with
   `TransferLocked`.
5. Cancel it from the Pending screen, or wait out the cooldown and let it execute, either one
   confirms the mechanism is live.

This is the step that actually matters for a demo: it is the one place a live signature meets a
live contract, and it is the one path that genuinely cannot be scripted safely.

## After deploying

Update the `Status` table in [`README.md`](../README.md) — it currently says nothing is deployed
on a public network — and record the Sepolia contract and registry addresses somewhere a viewer of
a demo can check them independently (an Etherscan link is enough).
