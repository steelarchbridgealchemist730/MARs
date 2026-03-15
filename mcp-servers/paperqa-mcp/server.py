"""
PaperQA2 MCP Server
Wraps PaperQA2 as a Model Context Protocol server for paper-based Q&A.

Usage:
    python server.py [--port 3001]

MCP config:
    {"type": "sse", "url": "http://127.0.0.1:3001/sse"}
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    from mcp.server import Server
    from mcp.server.sse import SseServerTransport
    from mcp.types import TextContent, Tool
except ImportError:
    print("Error: mcp package not installed. Run: pip install 'mcp[server]'")
    sys.exit(1)

try:
    import paperqa
    HAS_PAPERQA = True
except ImportError:
    HAS_PAPERQA = False

server = Server("paperqa-mcp")


def _run_pqa_cli(args: list[str], timeout: int = 300) -> str:
    """Run paperqa CLI command and return output."""
    cmd = [sys.executable, "-m", "paperqa"] + args
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(f"pqa failed: {result.stderr or result.stdout}")
    return result.stdout.strip()


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="index_papers",
            description="Index all PDF papers in the specified directory for Q&A",
            inputSchema={
                "type": "object",
                "properties": {
                    "paper_dir": {
                        "type": "string",
                        "description": "Directory containing PDF files to index",
                        "default": "literature/papers",
                    },
                    "index_name": {
                        "type": "string",
                        "description": "Name for the index",
                        "default": "default",
                    },
                },
            },
        ),
        Tool(
            name="ask_papers",
            description="Ask a question about indexed papers and get an answer with citations",
            inputSchema={
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question to ask about the papers",
                    },
                    "index_name": {
                        "type": "string",
                        "description": "Name of the index to query",
                        "default": "default",
                    },
                },
                "required": ["question"],
            },
        ),
        Tool(
            name="search_papers",
            description="Full-text search across indexed papers",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query",
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Number of results to return",
                        "default": 10,
                    },
                },
                "required": ["query"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    if not HAS_PAPERQA:
        return [
            TextContent(
                type="text",
                text="Error: paper-qa is not installed. Run: pip install paper-qa",
            )
        ]

    try:
        if name == "index_papers":
            paper_dir = arguments.get("paper_dir", "literature/papers")
            settings_json = json.dumps({"paper_directory": paper_dir})
            result = await asyncio.to_thread(
                _run_pqa_cli,
                ["--settings", settings_json, "index"],
            )
            return [TextContent(type="text", text=f"Indexing complete.\n{result}")]

        elif name == "ask_papers":
            question = arguments["question"]
            paper_dir = arguments.get("paper_dir", "literature/papers")
            settings_json = json.dumps({"paper_directory": paper_dir})
            result = await asyncio.to_thread(
                _run_pqa_cli,
                ["--settings", settings_json, "ask", question],
                timeout=300,
            )
            return [TextContent(type="text", text=result)]

        elif name == "search_papers":
            query = arguments["query"]
            paper_dir = arguments.get("paper_dir", "literature/papers")
            settings_json = json.dumps({"paper_directory": paper_dir})
            result = await asyncio.to_thread(
                _run_pqa_cli,
                ["--settings", settings_json, "search", query],
            )
            return [TextContent(type="text", text=result)]

        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]

    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]


async def main(port: int = 3001) -> None:
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
    parser = argparse.ArgumentParser(description="PaperQA2 MCP Server")
    parser.add_argument("--port", type=int, default=3001)
    args = parser.parse_args()
    asyncio.run(main(port=args.port))
