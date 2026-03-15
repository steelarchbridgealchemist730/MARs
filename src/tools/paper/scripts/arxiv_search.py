"""
arXiv API Search Wrapper for Claude Paper
Usage: python arxiv_search.py --query "search terms" [options]

Options:
  --query          Search keywords (required)
  --max-results    Maximum results to return (default: 50)
  --categories     Comma-separated arXiv categories, e.g. "cs.LG,stat.ML"
  --sort-by        One of: relevance, lastUpdatedDate, submittedDate (default: relevance)
  --sort-order     One of: ascending, descending (default: descending)
  --start          Offset for pagination (default: 0)

Dependencies: None (stdlib only)
"""

import sys
import json
import argparse
import time
import urllib.request
import urllib.parse
import urllib.error
import xml.etree.ElementTree as ET
from typing import Optional


ARXIV_API_URL = "http://export.arxiv.org/api/query"
RATE_LIMIT_SECONDS = 3

# Atom / arXiv XML namespaces
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
    "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}


def build_query(query: str, categories: Optional[list[str]] = None) -> str:
    """Build an arXiv API search_query string."""
    base = f"all:{query}"
    if categories:
        cat_clause = " OR ".join(f"cat:{c}" for c in categories)
        return f"({base}) AND ({cat_clause})"
    return base


def fetch_arxiv(
    query: str,
    max_results: int = 50,
    categories: Optional[list[str]] = None,
    sort_by: str = "relevance",
    sort_order: str = "descending",
    start: int = 0,
) -> dict:
    """Fetch results from the arXiv API and return parsed JSON-ready dict."""
    search_query = build_query(query, categories)

    params = urllib.parse.urlencode({
        "search_query": search_query,
        "start": start,
        "max_results": max_results,
        "sortBy": sort_by,
        "sortOrder": sort_order,
    })

    url = f"{ARXIV_API_URL}?{params}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Claude-Paper/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            xml_data = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return {"error": f"arXiv API HTTP error: {e.code} {e.reason}", "papers": [], "total_results": 0, "query": query}
    except urllib.error.URLError as e:
        return {"error": f"arXiv API connection error: {e.reason}", "papers": [], "total_results": 0, "query": query}
    except Exception as e:
        return {"error": f"arXiv API request failed: {str(e)}", "papers": [], "total_results": 0, "query": query}

    return parse_response(xml_data, query)


def parse_response(xml_data: str, query: str) -> dict:
    """Parse Atom XML response from arXiv API."""
    try:
        root = ET.fromstring(xml_data)
    except ET.ParseError as e:
        return {"error": f"XML parse error: {str(e)}", "papers": [], "total_results": 0, "query": query}

    # Extract total results from opensearch:totalResults
    total_el = root.find("opensearch:totalResults", NS)
    total_results = int(total_el.text) if total_el is not None and total_el.text else 0

    papers = []
    for entry in root.findall("atom:entry", NS):
        paper = parse_entry(entry)
        if paper:
            papers.append(paper)

    return {
        "papers": papers,
        "total_results": total_results,
        "query": query,
    }


def parse_entry(entry: ET.Element) -> Optional[dict]:
    """Parse a single <entry> element into a paper dict."""
    def get_text(tag: str, ns: str = "atom") -> str:
        el = entry.find(f"{ns}:{tag}", NS)
        if el is not None and el.text:
            return " ".join(el.text.strip().split())
        return ""

    # arXiv ID from <id> tag (strip URL prefix)
    raw_id = get_text("id")
    arxiv_id = raw_id.replace("http://arxiv.org/abs/", "").replace("https://arxiv.org/abs/", "")
    if not arxiv_id:
        return None

    title = get_text("title")
    summary = get_text("summary")
    published = get_text("published")
    updated = get_text("updated")
    comment = get_text("comment", ns="arxiv")

    # Authors
    authors = []
    for author_el in entry.findall("atom:author", NS):
        name_el = author_el.find("atom:name", NS)
        if name_el is not None and name_el.text:
            authors.append(name_el.text.strip())

    # Categories
    categories = []
    for cat_el in entry.findall("atom:category", NS):
        term = cat_el.get("term")
        if term:
            categories.append(term)

    # PDF link
    pdf_url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"
    for link_el in entry.findall("atom:link", NS):
        if link_el.get("title") == "pdf":
            href = link_el.get("href")
            if href:
                pdf_url = href
            break

    # DOI
    doi_el = entry.find("arxiv:doi", NS)
    doi = doi_el.text.strip() if doi_el is not None and doi_el.text else None

    paper = {
        "arxiv_id": arxiv_id,
        "title": title,
        "summary": summary,
        "authors": authors,
        "categories": categories,
        "published": published,
        "updated": updated,
        "pdf_url": pdf_url,
    }

    if doi:
        paper["doi"] = doi
    if comment:
        paper["comment"] = comment

    return paper


def main():
    parser = argparse.ArgumentParser(description="arXiv API search wrapper for Claude Paper")
    parser.add_argument("--query", required=True, help="Search keywords")
    parser.add_argument("--max-results", type=int, default=50, help="Maximum results (default: 50)")
    parser.add_argument("--categories", type=str, default=None, help="Comma-separated arXiv categories")
    parser.add_argument("--sort-by", type=str, default="relevance",
                        choices=["relevance", "lastUpdatedDate", "submittedDate"],
                        help="Sort criterion (default: relevance)")
    parser.add_argument("--sort-order", type=str, default="descending",
                        choices=["ascending", "descending"],
                        help="Sort order (default: descending)")
    parser.add_argument("--start", type=int, default=0, help="Pagination offset (default: 0)")

    args = parser.parse_args()

    categories = None
    if args.categories:
        categories = [c.strip() for c in args.categories.split(",") if c.strip()]

    # Rate limiting: sleep before request to respect arXiv's 1 req / 3s guideline
    if args.start > 0:
        time.sleep(RATE_LIMIT_SECONDS)

    result = fetch_arxiv(
        query=args.query,
        max_results=args.max_results,
        categories=categories,
        sort_by=args.sort_by,
        sort_order=args.sort_order,
        start=args.start,
    )

    print(json.dumps(result, ensure_ascii=False, indent=2))

    if "error" in result:
        sys.exit(1)


if __name__ == "__main__":
    main()
