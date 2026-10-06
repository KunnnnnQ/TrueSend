# Deploying to Sepolia

Everything in this file is a real transaction on a real, if worthless, network. Nothing here
touches a private key on the assistant's behalf — every `--account`/`--broadcast` step is one you
run yourself, from your own keystore. What follows is the order that works and the reasons for it,
so a rerun after a mistake does not mean starting over.

## Before any of this

- **Sepolia ETH.** Step 0 prints the exact figure at the current gas price. Measured on 2026-10-06:
  about 8.3 million gas for all three scripts — Deploy 5.9M, RegisterSchema 1.6M, Smoke 0.9M — or
  about 0.01 ETH at that day's 1.1–1.2 gwei, so a few hundredths of an ETH is plenty unless Sepolia's
  gas price spikes. The smoke test in step 3 also deposits 0.00002 ETH into a vault it creates for
  you, where it stays — yours, and recoverable, as step 3 explains. Faucets: the one at
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

## 0. Rehearse it first: one command, free

From the repository root:

```bash
node tools/rehearse-sepolia.mjs
```

It runs steps 1–3 below against a private copy of Sepolia on your own machine, then prints `PASSED`
and what the real deployment will cost at Sepolia's gas price right now. Nothing is sent to Sepolia,
no key or ETH of yours is used, and nothing in this repository is written. It takes about half a
minute. If it does not say `PASSED`, do not go on to step 1.

What it does, for anyone checking: forks Sepolia with `anvil`, runs the three scripts from a freshly
generated keystore account funded on the fork only, in a temporary copy of `contracts/` — so the
deployment files they write, which would otherwise look exactly like a real Sepolia record, can
never be committed — and deletes the copy and stops the fork afterwards. It needs Foundry and the
contract libraries (`git submodule update --init`), not `pnpm install`.

One difference from the real run it cannot remove: it passes the keystore password with
`--password`, because a script cannot type into forge's password prompt. That difference hid a real
bug once — see step 3 — and the scripts no longer depend on it.

Last run on 2026-10-06, Foundry 1.8.3, Sepolia block 11,854,109: all three passed, Smoke's eight
checks passed, about 8.3M gas, about 0.0097 ETH at 1.16 gwei. A pass also means the EAS addresses
hard-coded in `RegisterSchema.s.sol` are live on Sepolia: Smoke's attestation goes through them.
What a fork cannot rehearse: Etherscan verification (`--verify` needs your API key and a real
deployment), and anything about your own key, keystore or balance.

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
error means everything downstream is wired correctly.

The first real Sepolia run, on 2026-10-06, failed too, with `Unauthorized()`, after every rehearsal
had passed. The script took `msg.sender` to be the deployer; with the password typed at forge's
prompt, `msg.sender` in a script is forge's default address, so the test vault was created for that
address and the deployed contract refused to let the real deployer use it. Forge simulates before it
broadcasts, so nothing was sent and nothing was spent. The script now reads the signing account from
inside a broadcast, and CI fails any deploy script that reads `msg.sender`. Steps 1 and 2 had already
succeeded and did not need repeating: neither depends on who calls them. Read `contracts/script/Smoke.s.sol`'s doc
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
