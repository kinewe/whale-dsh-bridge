import subprocess, json, sys, re

mode = sys.argv[1] if len(sys.argv) > 1 else 'list'

def ps(script):
    out = subprocess.run(['powershell', '-NoProfile', '-Command', script], capture_output=True, text=True, encoding='utf-8', errors='replace')
    return out.stdout

raw = ps("Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Depth 3")
try:
    items = json.loads(raw) if raw.strip() else []
except Exception:
    items = []
if isinstance(items, dict):
    items = [items]

targets = []
for it in items:
    cmd = it.get('CommandLine') or ''
    if 'whale-agent' in cmd and '--json' in cmd and 'dsh-desktop-host' in cmd:
        targets.append(it)
print('matched', len(targets))
for t in targets:
    print(t['ProcessId'], str(t.get('CreationDate'))[:19], (t.get('CommandLine') or '')[:180])

if mode == 'kill':
    ps("Stop-Process -Id " + ",".join(str(t['ProcessId']) for t in targets) + " -Force") if targets else None
    print('killed', len(targets))
