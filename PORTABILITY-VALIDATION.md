# Compiled CLI portability regression

Run this on the Mac build host after dependencies are already installed. Build
from a disposable copy so the test can remove the exact source path recorded
by Bun; do not move or rename the active checkout or its `node_modules`.

```sh
tmp="$(mktemp -d)"
ditto --norsrc --noextattr "$PWD" "$tmp/source"
(cd "$tmp/source/packages/cli" && bun run compile:host)
cp "$tmp/source/packages/cli/dist/openllm" "$tmp/openllm"
rm -rf "$tmp/source"
OPENLLM_COMPILED_CLI="$tmp/openllm" bun test tests/cli/compiled-portability.test.ts
rm -rf "$tmp"
```

The test runs `claude --help`, which enters the normal full dispatcher and
imports the session client while requiring no installed client, daemon, or
network. With the old `createRequire(import.meta.url)` calls, the removed build
tree makes dispatch fail to resolve `cross-spawn`; with static imports, both
`cross-spawn` and its Windows command escaping helper are embedded at compile
time. This check intentionally runs against an already compiled artifact.
