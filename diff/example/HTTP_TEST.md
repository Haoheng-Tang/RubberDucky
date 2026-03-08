# HTTP mode quick test

1. Start mock server:

```bash
node ./example/mock-server.mjs
```

2. In VS Code open this workspace, ensure extension `your-name.toggle-diff-watcher` is enabled, and run `Developer: Reload Window` once.

3. Open `example/demo.txt`, edit it, and keep it unsaved.

4. Trigger `diff` command from another terminal:

```bash
./example/set-dirty-diff.sh
```

5. The extension polls `GET /dirty` every 100ms. When it gets JSON `{"command":"diff"}`, it computes diff (saved-on-disk vs unsaved editor text) and posts JSON to `POST /diff`.

6. Check what server received:

```bash
./example/check-last-diff.sh
```

7. You can also inspect extension logs in VS Code Output panel: `Toggle Diff Watcher`.
