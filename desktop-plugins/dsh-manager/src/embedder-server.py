#!/usr/bin/env python3
"""OpenAI-compatible /v1/embeddings for PentAGI pgvector (local fastembed)."""
from __future__ import annotations

import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("DSH_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
# 容器要经 vmnet 接口取向量，所以默认绑所有接口；鉴权由 DSH_EMBED_KEY 承担，
# 否则等于把本机 embedding 端点裸露给整个局域网。
BIND = os.environ.get("DSH_EMBED_BIND", "0.0.0.0")
PORT = int(os.environ.get("DSH_EMBED_PORT", "63229"))
KEY = os.environ.get("DSH_EMBED_KEY", "")

_model = None


def embedder():
    global _model
    if _model is None:
        from fastembed import TextEmbedding
        _model = TextEmbedding(model_name=MODEL)
    return _model


def vectors(texts: list[str]) -> list[list[float]]:
    out = []
    for vec in embedder().embed(texts):
        out.append([float(x) for x in vec])
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/health", "/v1/health"):
            self._send(200, {"ok": True, "model": MODEL})
            return
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            self._send(200, {
                "object": "list",
                "data": [
                    {"id": MODEL, "object": "model", "owned_by": "dsh-local"},
                    {"id": "text-embedding-3-small", "object": "model", "owned_by": "dsh-local"},
                    {"id": "text-embedding-ada-002", "object": "model", "owned_by": "dsh-local"},
                ],
            })
            return
        self._send(404, {"error": {"message": "not found", "type": "invalid_request"}})

    def _authorized(self) -> bool:
        """绑 0.0.0.0 后必须鉴权，否则本机 embedding 端点对局域网敞开。"""
        if not KEY:
            return True
        header = self.headers.get("Authorization") or ""
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        return hmac.compare_digest(token, KEY)

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/embeddings", "/embeddings"):
            self._send(404, {"error": {"message": "not found", "type": "invalid_request"}})
            return
        if not self._authorized():
            self._send(401, {"error": {"message": "invalid api key", "type": "invalid_request"}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send(400, {"error": {"message": "invalid json", "type": "invalid_request"}})
            return
        inp = data.get("input", "")
        if isinstance(inp, str):
            texts = [inp]
        elif isinstance(inp, list):
            texts = ["" if item is None else str(item) for item in inp]
        else:
            texts = [str(inp)]
        if not texts:
            texts = [""]
        try:
            embs = vectors(texts)
        except Exception as exc:
            self._send(500, {"error": {"message": str(exc), "type": "server_error"}})
            return
        model = str(data.get("model") or MODEL)
        self._send(200, {
            "object": "list",
            "data": [
                {"object": "embedding", "index": i, "embedding": vec}
                for i, vec in enumerate(embs)
            ],
            "model": model,
            "usage": {"prompt_tokens": 0, "total_tokens": 0},
        })


def main():
    embedder()
    httpd = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"listening {BIND}:{PORT} model={MODEL}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
