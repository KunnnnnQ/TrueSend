# Deployments

`forge script script/Deploy.s.sol --broadcast` writes `<chainid>.json` here, and the web app reads
it rather than carrying hand-copied addresses.

Nothing is deployed yet. A chain with no file here is not deployed, and the app says so instead of
pointing at a placeholder.

To run the whole thing locally:

```bash
anvil
```

```bash
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

That key is anvil's first well-known test account. It holds nothing on any real network.
