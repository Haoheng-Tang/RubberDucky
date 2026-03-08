# Quick Test

1. Open this workspace in VS Code.
2. Open `example/demo.txt`.
3. Edit the file without saving. For example, change `bravo` to `bravo changed` and add a new line `delta`.
4. Run this command from the project root:

```bash
./example/trigger-toggle.sh
```

5. Wait about 1 second. The extension should:
- detect `toggle.txt = 1`
- compare unsaved editor text with saved disk content
- write a diff file in `example/` named like `demo-line-diff-YYYYMMDD-HHMMSS-MMM.txt`
- save `example/demo.txt`
- reset `toggle.txt` back to `0`

6. Verify:

```bash
cat toggle.txt
ls -t example/demo-line-diff-*.txt | head -n 1
```

7. Open the newest diff file to confirm it contains `-`/`+` line changes.
