"""Run the packaged Hindsight API over the app's private Unix socket."""
import os
import sys
import threading
import time

socket_path, site_packages, hindsight_source, parent_pid = sys.argv[1:]
parent_pid = int(parent_pid)


def watch_parent():
    while os.getppid() == parent_pid:
        time.sleep(1)
    os._exit(1)


threading.Thread(target=watch_parent, daemon=True).start()
sys.path[:0] = [hindsight_source, site_packages]
os.umask(0o077)

import uvicorn
from hindsight_api.api import create_app
from hindsight_api.engine import MemoryEngine

memory = MemoryEngine(run_migrations=True)
app = create_app(
    memory=memory,
    http_api_enabled=True,
    mcp_api_enabled=False,
    initialize_memory=True,
)
uvicorn.run(app, uds=socket_path, loop="asyncio", ws="none", proxy_headers=False, access_log=False)
