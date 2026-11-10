"""A tiny OpenAI-compatible server that always answers in prose.

It stands in for "the cheap model that breaks your JSON", so the demo's
failing leg fails the same way on every take. Standard library only.

    POST /v1/chat/completions  -> a chat completion whose content is prose
    GET  /v1/models            -> one model, prose-only
"""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "prose-only"
ANSWER = (
    "Sure! I'd be happy to help with that. Here is what I found: "
    "the details you asked for are listed above in plain words."
)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            self._send(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "firedrill-demo"}]})
        elif self.path == "/health":
            self._send(200, {"status": "ok"})
        else:
            self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._send(400, {"error": {"message": "invalid JSON body"}})
            return
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._send(404, {"error": {"message": "not found"}})
            return
        prompt_chars = sum(len(str(m.get("content", ""))) for m in request.get("messages", []))
        self._send(
            200,
            {
                "id": f"chatcmpl-fake-{int(time.time() * 1000)}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": MODEL,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": ANSWER}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": max(1, prompt_chars // 4), "completion_tokens": 32, "total_tokens": max(1, prompt_chars // 4) + 32},
            },
        )

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 9100), Handler).serve_forever()
