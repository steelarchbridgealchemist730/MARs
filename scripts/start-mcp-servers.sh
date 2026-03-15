#!/bin/bash
# Start all Claude Paper MCP servers

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MCP_DIR="$PROJECT_DIR/mcp-servers"

echo "Starting Claude Paper MCP servers..."

# Start PaperQA MCP server
echo "Starting PaperQA MCP server on port 3001..."
python3 "$MCP_DIR/paperqa-mcp/server.py" --port 3001 &
PQA_PID=$!

# Start Academic Search MCP server
echo "Starting Academic Search MCP server on port 3002..."
python3 "$MCP_DIR/academic-search-mcp/server.py" --port 3002 &
SEARCH_PID=$!

echo ""
echo "MCP servers started:"
echo "  PaperQA:         http://127.0.0.1:3001/sse (PID: $PQA_PID)"
echo "  Academic Search:  http://127.0.0.1:3002/sse (PID: $SEARCH_PID)"
echo ""
echo "To stop: kill $PQA_PID $SEARCH_PID"

# Health check after 3 seconds
sleep 3
for port in 3001 3002; do
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/sse" | grep -q "200\|405"; then
        echo "  Port $port: OK"
    else
        echo "  Port $port: WARNING - may not be ready yet"
    fi
done

# Wait for both servers
wait
