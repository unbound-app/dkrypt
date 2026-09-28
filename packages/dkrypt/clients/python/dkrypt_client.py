from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.parse import SplitResult, urljoin, urlsplit
from urllib.request import Request, urlopen

ROUTES = (
    "GET /v1/artifacts",
    "GET /v1/artifacts/{id}",
    "GET /v1/artifacts/{id}/file",
    "GET /v1/decrypt",
    "GET /v1/jobs/{id}",
    "POST /v1/decrypts",
    "POST /v1/testflight/decrypt",
)

@dataclass
class DkryptClient:
    base_url: str
    api_key: str | None = None

    def request(self, method: str, path: str, body: object | None = None) -> object:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        response = self._send(method, path, payload, "application/json")
        return json.loads(response.decode("utf-8"))

    def download(self, path: str) -> bytes:
        return self._send("GET", path, None, "application/octet-stream")

    def _send(self, method: str, path: str, payload: bytes | None, accept: str) -> bytes:
        headers = {"Accept": accept}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self._build_url(path), data=payload, headers=headers, method=method.upper())
        if self.api_key:
            request.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
        try:
            with urlopen(request) as response:
                return response.read()
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"dkrypt request failed with HTTP {error.code}: {detail}") from error

    def _build_url(self, path: str) -> str:
        base_url = self.base_url.rstrip("/") + "/"
        request_url = urljoin(base_url, path)
        base = urlsplit(base_url)
        target = urlsplit(request_url)
        if (
            target.scheme.lower() not in ("http", "https")
            or target.username is not None
            or target.password is not None
            or self._origin(base) != self._origin(target)
        ):
            raise ValueError("dkrypt requests must use the configured origin")
        return request_url

    @staticmethod
    def _origin(url: SplitResult) -> tuple[str, str | None, int]:
        scheme = url.scheme.lower()
        default_port = 443 if scheme == "https" else 80
        port = url.port
        return scheme, url.hostname, default_port if port is None else port
