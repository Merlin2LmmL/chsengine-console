#!/usr/bin/env python3
"""WebSocket UCI proxy for native rust binary (replaces sync HTTP)."""
import asyncio, websockets, subprocess, sys

async def handler(ws, path):
    proc = subprocess.Popen(
        ["./uci_binary"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, bufsize=1
    )
    async def reader():
        for line in proc.stdout:
            await ws.send(line.strip())
    asyncio.create_task(reader())
    async for msg in ws:
        proc.stdin.write(msg + "\n")
        proc.stdin.flush()

start_server = websockets.serve(handler, "localhost", 8765)
asyncio.get_event_loop().run_until_complete(start_server)
asyncio.get_event_loop().run_forever()
