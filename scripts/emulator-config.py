"""Apply a fixture configuration through the emulator's actual phone webview protocol."""
import json
import struct
import sys
import time
from pathlib import Path
from urllib.parse import quote
import websocket

info = json.loads(Path('/tmp/pb-emulator.json').read_text())['emery']
port = info.get('pypkjs', {}).get('port')
if not port:
    # pebble-tool stores SDK-specific state on recent versions.
    for value in info.values():
        if isinstance(value, dict) and 'pypkjs' in value:
            port = value['pypkjs']['port']
            break
if not port:
    raise SystemExit('Émulateur Time 2 absent.')
ws = websocket.create_connection('ws://127.0.0.1:%s/' % port, timeout=10)
ws.send_binary(bytes([0x0a, 0x01]))
while True:
    message = ws.recv()
    if isinstance(message, bytes) and message[:2] == bytes([0x0a, 0x01]):
        break
payload = quote(Path(sys.argv[1]).read_text(), safe='').encode()
ws.send_binary(bytes([0x0a, 0x02]) + struct.pack('>I', len(payload)) + payload)
time.sleep(1)
ws.close()
print('Réglages transmis au compagnon de l’émulateur.')
