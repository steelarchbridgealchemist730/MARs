"""
Academic Search MCP Server
Unified search interface for arXiv, Semantic Scholar, and SSRN.

Usage:
    python server.py [--port 3002]

MCP config:
    {"type": "sse", "url": "http://127.0.0.1:3002/sse"}
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from typing import Any
from xml.etree import ElementTree as ET

try:
    from mcp.server import Server
    from mcp.server.sse import SseServerTransport
    from mcp.types import TextContent, Tool
except ImportError:
    print("Error: mcp package not installed. Run: pip install 'mcp[server]'")
    sys.exit(1)

server = Server("academic-search-mcp")

S2_API_KEY = os.environ.get("S2_API_KEY", "")
S2_API_BASE = "https://api.semanticscholar.org/graph/v1"
ARXIV_API_BASE = "http://export.arxiv.org/api/query"


async def _search_arxiv(
    query: str, max_results: int = 20, categories: list[str] | None = None
) -> list[dict]:
    """Search arXiv API."""
    encoded_query = urllib.parse.quote(query)
    if categories:
        cat_query = "+OR+".join(f"cat:{c}" for c in categories)
        search_query = f"all:({encoded_query})+AND+({cat_query})"
    else:
        search_query = f"all:{encoded_query}"

    url = f"{ARXIV_API_BASE}?search_query={search_query}&start=0&max_results={max_results}&sortBy=relevance"

    def _fetch():
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8")

    xml_text = await asyncio.to_thread(_fetch)
    # Throttle for arXiv rate limit
    await asyncio.sleep(3)

    papers = []
    ns = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
    root = ET.fromstring(xml_text)
    for entry in root.findall("atom:entry", ns):
        paper_id = (entry.findtext("atom:id", "", ns) or "").replace("http://arxiv.org/abs/", "")
        title = (entry.findtext("atom:title", "", ns) or "").strip().replace("\n", " ")
        abstract = (entry.findtext("atom:summary", "", ns) or "").strip().replace("\n", " ")
        published = entry.findtext("atom:published", "", ns) or ""

        authors = []
        for author in entry.findall("atom:author", ns):
            name = author.findtext("atom:name", "", ns)
            if name:
                authors.append(name.strip())

        categories = []
        for cat in entry.findall("atom:category", ns):
            term = cat.get("term", "")
            if term:
                categories.append(term)

        papers.append({
            "source": "arxiv",
            "id": paper_id,
            "title": title,
            "authors": authors,
            "abstract": abstract[:500],
            "published": published,
            "categories": categories,
            "pdf_url": f"https://arxiv.org/pdf/{paper_id}.pdf",
        })

    return papers


async def _search_s2(
    query: str, max_results: int = 20, year_from: int | None = None,
    fields_of_study: list[str] | None = None,
) -> list[dict]:
    """Search Semantic Scholar API."""
    fields = "paperId,title,authors,year,abstract,citationCount,isOpenAccess,openAccessPdf,externalIds,fieldsOfStudy"
    params: dict[str, str] = {
        "query": query,
        "limit": str(max_results),
        "fields": fields,
    }
    if year_from:
        params["year"] = f"{year_from}-"
    if fields_of_study:
        params["fieldsOfStudy"] = ",".join(fields_of_study)

    url = f"{S2_API_BASE}/paper/search?{urllib.parse.urlencode(params)}"

    def _fetch():
        req = urllib.request.Request(url)
        req.add_header("Content-Type", "application/json")
        if S2_API_KEY:
            req.add_header("x-api-key", S2_API_KEY)
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))

    data = await asyncio.to_thread(_fetch)

    papers = []
    for p in data.get("data", []):
        paper = {
            "source": "semantic_scholar",
            "id": p.get("paperId", ""),
            "title": p.get("title", ""),
            "authors": [a.get("name", "") for a in (p.get("authors") or [])],
            "abstract": (p.get("abstract") or "")[:500],
            "year": p.get("year"),
            "citation_count": p.get("citationCount", 0),
            "is_open_access": p.get("isOpenAccess", False),
            "fields_of_study": p.get("fieldsOfStudy") or [],
        }
        oa_pdf = p.get("openAccessPdf")
        if oa_pdf and oa_pdf.get("url"):
            paper["pdf_url"] = oa_pdf["url"]
        ext_ids = p.get("externalIds") or {}
        if ext_ids.get("ArXiv"):
            paper["arxiv_id"] = ext_ids["ArXiv"]
        if ext_ids.get("SSRN"):
            paper["ssrn_id"] = ext_ids["SSRN"]
        if ext_ids.get("DOI"):
            paper["doi"] = ext_ids["DOI"]
        papers.append(paper)

    return papers


async def _search_ssrn(query: str, max_results: int = 20) -> list[dict]:
    """Search SSRN via Semantic Scholar (filter for SSRN papers)."""
    all_papers = await _search_s2(query, max_results=max_results * 3)
    ssrn_papers = [p for p in all_papers if p.get("ssrn_id")][:max_results]
    for p in ssrn_papers:
        p["source"] = "ssrn"
        p["ssrn_url"] = f"https://papers.ssrn.com/sol3/papers.cfm?abstract_id={p['ssrn_id']}"
    return ssrn_papers


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="unified_search",
            description="Search multiple academic databases simultaneously (arXiv, Semantic Scholar, SSRN)",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "sources": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["arxiv", "s2", "ssrn"]},
                        "description": "Databases to search",
                        "default": ["arxiv", "s2"],
                    },
                    "max_per_source": {
                        "type": "integer",
                        "description": "Max results per source",
                        "default": 20,
                    },
                    "year_from": {
                        "type": "integer",
                        "description": "Minimum publication year",
                    },
                    "fields_of_study": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Field of study filters",
                    },
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="download_paper",
            description="Download a paper PDF from a given URL",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "PDF URL"},
                    "paper_id": {"type": "string", "description": "Paper identifier for naming"},
                    "save_dir": {
                        "type": "string",
                        "description": "Save directory",
                        "default": "literature/papers",
                    },
                },
                "required": ["url", "paper_id"],
            },
        ),
        Tool(
            name="get_citation_graph",
            description="Get citations and references for a paper (Semantic Scholar)",
            inputSchema={
                "type": "object",
                "properties": {
                    "paper_id": {"type": "string", "description": "Semantic Scholar paper ID"},
                    "direction": {
                        "type": "string",
                        "enum": ["citations", "references", "both"],
                        "default": "both",
                    },
                    "limit": {"type": "integer", "default": 20},
                },
                "required": ["paper_id"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    try:
        if name == "unified_search":
            query = arguments["query"]
            sources = arguments.get("sources", ["arxiv", "s2"])
            max_per = arguments.get("max_per_source", 20)
            year_from = arguments.get("year_from")
            fields = arguments.get("fields_of_study")

            tasks = []
            if "arxiv" in sources:
                tasks.append(("arxiv", _search_arxiv(query, max_per)))
            if "s2" in sources:
                tasks.append(("s2", _search_s2(query, max_per, year_from, fields)))
            if "ssrn" in sources:
                tasks.append(("ssrn", _search_ssrn(query, max_per)))

            results: dict[str, list[dict]] = {}
            for source, coro in tasks:
                try:
                    results[source] = await coro
                except Exception as e:
                    results[source] = [{"error": str(e)}]

            total = sum(len(v) for v in results.values())
            output = f"Found {total} papers across {len(results)} sources.\n\n"
            output += json.dumps(results, indent=2, ensure_ascii=False)
            return [TextContent(type="text", text=output)]

        elif name == "download_paper":
            url = arguments["url"]
            paper_id = arguments["paper_id"]
            save_dir = arguments.get("save_dir", "literature/papers")
            os.makedirs(save_dir, exist_ok=True)

            sanitized = re.sub(r"[^a-zA-Z0-9._-]", "_", paper_id)
            filepath = os.path.join(save_dir, f"{sanitized}.pdf")

            def _download():
                req = urllib.request.Request(url)
                req.add_header("User-Agent", "Claude-Paper/1.0")
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = resp.read()
                if not data[:5] == b"%PDF-":
                    raise ValueError("Downloaded file is not a valid PDF")
                with open(filepath, "wb") as f:
                    f.write(data)
                return len(data)

            size = await asyncio.to_thread(_download)
            return [TextContent(type="text", text=f"Downloaded {size} bytes to {filepath}")]

        elif name == "get_citation_graph":
            paper_id = arguments["paper_id"]
            direction = arguments.get("direction", "both")
            limit = arguments.get("limit", 20)
            fields = "paperId,title,authors,year,citationCount"

            result: dict[str, Any] = {"paper_id": paper_id}

            def _fetch_graph(endpoint: str):
                url = f"{S2_API_BASE}/paper/{paper_id}/{endpoint}?fields={fields}&limit={limit}"
                req = urllib.request.Request(url)
                if S2_API_KEY:
                    req.add_header("x-api-key", S2_API_KEY)
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.loads(resp.read().decode("utf-8"))

            if direction in ("citations", "both"):
                data = await asyncio.to_thread(_fetch_graph, "citations")
                result["citations"] = [
                    c.get("citingPaper", {}) for c in data.get("data", [])
                ]

            if direction in ("references", "both"):
                data = await asyncio.to_thread(_fetch_graph, "references")
                result["references"] = [
                    r.get("citedPaper", {}) for r in data.get("data", [])
                ]

            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]

    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]


async def main(port: int = 3002) -> None:
    from starlette.applications import Starlette
    from starlette.routing import Route

    sse = SseServerTransport("/messages/")

    async def handle_sse(request):
        async with sse.connect_sse(
            request.scope, request.receive, request._send
        ) as streams:
            await server.run(
                streams[0], streams[1], server.create_initialization_options()
            )

    app = Starlette(
        routes=[
            Route("/sse", endpoint=handle_sse),
            Route("/messages/", endpoint=sse.handle_post_message, methods=["POST"]),
        ],
    )

    import uvicorn
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="info")
    srv = uvicorn.Server(config)
    await srv.serve()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Academic Search MCP Server")
    parser.add_argument("--port", type=int, default=3002)
    args = parser.parse_args()
    asyncio.run(main(port=args.port))
