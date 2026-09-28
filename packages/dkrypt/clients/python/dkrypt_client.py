from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROUTES = (
    "GET /v1/artifacts",
    "GET /v1/artifacts/{id}",
    "GET /v1/artifacts/{id}/file",
    "GET /v1/decrypt",
    "GET /v1/jobs/{id}",
    "GET /v1/testflight/{appId}/builds",
    "GET /v1/testflight/{appId}/trains",
    "POST /v1/decrypts",
    "POST /v1/testflight/decrypt",
)

@dataclass
class DkryptClient:
    base_url: str
    api_key: str | None = None

    def request(self, method: str, path: str, body: object | None = None) -> object:
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = None if body is None else json.dumps(body).encode("utf-8")
        if payload is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.base_url.rstrip("/") + path, data=payload, headers=headers, method=method.upper())
        try:
            with urlopen(request) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"dkrypt request failed with HTTP {error.code}: {detail}") from error
