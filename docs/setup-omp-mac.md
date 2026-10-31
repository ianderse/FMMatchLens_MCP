# Setup with Oh My Pi (OMP) on a Mac: UNVERIFIED

**Status: unverified.** OMP is not installed on the development PC, so nothing in this file has been run against OMP or on a Mac.
The Slice 0 OMP spike (connect the installed OMP to a one-tool SDK v2 stdio server and record the result) remains open. This
file records only what the repository and the specification support, and marks the rest as unknown.

## What is supported by this repository

- The server is a plain MCP stdio server (`packages/mcp`, SDK v2 `@modelcontextprotocol/server` 2.4.0). Any client that can
  launch a stdio MCP server as a child process can in principle use it. Verified only with the official SDK v2 client on Windows.
- An optional authenticated Streamable HTTP transport now exists (Slice 5, `fmmi-mcp --http`, `docs/setup-windows.md` section 10). It
  has only been exercised on loopback in this repository's tests: **nothing about it has been run from a Mac, over Tailscale or
  against OMP, and every step below that uses it is unverified.** Do not expose the FMMatchLens port 16726 to the network,
  and do not tunnel the stdio server.
- The supported way to use a Mac is spec section 9.3, second option: copy the `.fmlens` archives to the Mac and run the same offline
  service there.

## Steps (offline service on the Mac; every step unverified)

1. Install Node.js >= 22.18 and run `npm install` in this repository. `better-sqlite3` is a native module; it has only been
   built and tested on Windows here. If it does not build on macOS, `node:sqlite` is the fallback named in the spec, which would
   need a code change.
2. Copy archives from `BepInEx/plugins/FMMatchLens/data/matches/` on the PC to the Mac (the files are not modified by this project).
3. Import them: `npm run fmmi -- save create "Farnham Town"` then `npm run fmmi -- ingest <dir> --save <saveId>`, with
   `FMMI_HOME` pointing at a folder of your choice.
4. Configure the client to launch `node packages/mcp/bin/fmmi-mcp.mjs --home <FMMI_HOME>` over stdio. The shape used by most
   clients is shown in `docs/setup-windows.md`; **OMP's own configuration file name and keys have not been checked** and must
   come from OMP's documentation once it is installed. Do not invent them from this file.

## To close the spike

On a machine with OMP installed: read OMP's MCP client documentation, add the stdio entry, call `list_matches`, then
`get_match_summary`, then `get_striker_service`, and record in `docs/data-coverage.md` whether OMP lists the thirteen tools, passes the
read-only annotations, shows `isError` results, and handles the ~10-18 KB results. Also record which local model was used and
whether it follows the `match_review` prompt (five sections, one action). If OMP cannot use the server, document the client to
use instead.

## Option B (unverified): the Windows PC serves MCP to the Mac over a private network

Nothing in this section has been run. It records what the code supports, so each step can be tried and corrected.

1. On the PC, install a private transport (Tailscale is the one the specification names) and note the PC's tailnet address and name. Do
   not use the LAN address.
2. On the PC create a token (`node packages\mcp\bin\fmmi-mcp.mjs --print-new-token`) and start the server bound to the tailnet address:
   `set FMMI_MCP_TOKEN=<token>` then
   `node packages\mcp\bin\fmmi-mcp.mjs --http --home <dir> --host <tailnet-ip-literal> --allow-non-loopback --private-transport tailscale --allow-host <pc-name>:8787 [--live]`.
   `--host` must be the literal tailnet IP, not a host name (host names are refused); the server also refuses to start if any of these is missing and refuses every spelling of a wildcard address. It speaks plain HTTP: the tailnet is what
   protects the traffic (or put a TLS-terminating proxy in front and use `--private-transport tls-proxy`).
3. On the Mac, give the client the URL `http://<pc-name>:8787/mcp` and the header `Authorization: Bearer <token>`. **OMP's own
   configuration keys have not been checked**; take them from OMP's documentation once it is installed. If OMP cannot send a custom
   header or speak Streamable HTTP, use the offline option above instead.
4. Check from the Mac: list the tools (thirteen, or sixteen with `--live`) and call `list_matches`.

To close the spike, record in `docs/data-coverage.md` whether this worked, which client was used and which keys it needed. The live tools
need the PC's game to be running and `fmmi live capture` / `fmmi live check` to have passed on that PC first (section 9 of
`docs/setup-windows.md`).
