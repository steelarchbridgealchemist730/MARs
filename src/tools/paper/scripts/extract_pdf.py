"""
PDF Structured Extractor for Claude Paper
Usage: python extract_pdf.py <pdf_path> <output_dir>

Extracts structured Markdown (via pymupdf4llm), renders figure pages as images,
parses references, and extracts metadata.

Dependencies: pymupdf4llm, pdfplumber, Pillow
Install: pip install pymupdf4llm pdfplumber Pillow
"""

import sys
import json
import re
from pathlib import Path


# ---------------------------------------------------------------------------
# Stage 1: Structured Markdown extraction
# ---------------------------------------------------------------------------

def _fallback_plain_text(pdf_path: str) -> str:
    """Plain text extraction via PyMuPDF as fallback."""
    import fitz
    with fitz.open(pdf_path) as doc:
        pages = [page.get_text("text") for page in doc]
    return "\n\n---\n\n".join(pages)


def extract_markdown(pdf_path: str, warnings: list[str]) -> tuple[str, list[dict]]:
    """
    Extract structured Markdown from PDF using pymupdf4llm.
    Falls back to PyMuPDF plain text if pymupdf4llm is unavailable.
    Returns (markdown_text, sections_list).
    """
    markdown = ""
    try:
        import pymupdf4llm
        markdown = pymupdf4llm.to_markdown(pdf_path, show_progress=False)
    except ImportError:
        warnings.append("pymupdf4llm not installed, falling back to plain text extraction")
        try:
            markdown = _fallback_plain_text(pdf_path)
        except Exception as e:
            warnings.append(f"Plain text fallback failed: {type(e).__name__}: {e}")
    except Exception as e:
        warnings.append(f"pymupdf4llm failed ({type(e).__name__}: {e}), falling back to plain text")
        try:
            markdown = _fallback_plain_text(pdf_path)
        except Exception as e2:
            warnings.append(f"Plain text fallback also failed: {type(e2).__name__}: {e2}")

    sections = parse_sections(markdown)
    return markdown, sections


def parse_sections(markdown: str) -> list[dict]:
    """Parse Markdown headings into a sections list."""
    sections = []
    for m in re.finditer(r'^(#{1,4})\s+(.+)$', markdown, re.MULTILINE):
        level = len(m.group(1))
        title = m.group(2).strip()
        sections.append({
            "title": title,
            "level": level,
            "char_offset": m.start(),
        })
    return sections


# ---------------------------------------------------------------------------
# Stage 1b: Table extraction (pdfplumber supplement)
# ---------------------------------------------------------------------------

def extract_tables(pdf_path: str, warnings: list[str]) -> list[dict]:
    """Extract tables using pdfplumber as a supplement to Markdown tables."""
    tables = []
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            for page_num, page in enumerate(pdf.pages):
                for table in page.extract_tables():
                    if table and len(table) > 1:
                        non_empty_rows = [r for r in table if any(c and c.strip() for c in r if c)]
                        if len(non_empty_rows) > 1:
                            tables.append({"page": page_num + 1, "data": table})
    except ImportError:
        warnings.append("pdfplumber not installed, table extraction skipped")
    except Exception as e:
        warnings.append(f"Table extraction failed: {type(e).__name__}: {e}")
    return tables


# ---------------------------------------------------------------------------
# Stage 2: Selective figure-page rendering
# ---------------------------------------------------------------------------

def detect_figure_pages(pdf_path: str, page_count: int) -> dict[int, list[str]]:
    """
    Locate figure captions on actual pages using PyMuPDF per-page text search.
    Returns {page_number: [caption1, caption2, ...]}.
    """
    page_captions: dict[int, list[str]] = {}
    if page_count == 0:
        return page_captions

    try:
        import fitz
        figure_pattern = re.compile(
            r'((?:Figure|Fig\.?)\s*\d+[.:]\s*.{5,200})',
            re.IGNORECASE
        )
        with fitz.open(pdf_path) as doc:
            for page_idx, page in enumerate(doc):
                text = page.get_text("text")
                for m in figure_pattern.finditer(text):
                    page_captions.setdefault(page_idx + 1, []).append(m.group(1).strip())
    except Exception:
        pass

    return page_captions


def render_figure_pages(pdf_path: str, output_dir: str, page_captions: dict[int, list[str]], warnings: list[str]) -> list[dict]:
    """
    Render only the pages that contain figures as PNG images at 150 DPI.
    Returns list of figure dicts with image_path, page, caption, dimensions.
    """
    figures = []
    if not page_captions:
        return figures

    try:
        import fitz
        figures_dir = Path(output_dir) / "figures"
        figures_dir.mkdir(parents=True, exist_ok=True)

        with fitz.open(pdf_path) as doc:
            for page_num_1based, captions in page_captions.items():
                page_idx = page_num_1based - 1
                if page_idx < 0 or page_idx >= len(doc):
                    continue

                page = doc[page_idx]
                pix = page.get_pixmap(dpi=150)
                img_filename = f"fig_page{page_num_1based}.png"
                img_path = figures_dir / img_filename
                pix.save(str(img_path))

                figures.append({
                    "image_path": str(img_path),
                    "page": page_num_1based,
                    "width": pix.width,
                    "height": pix.height,
                    "format": "png",
                    "captions": captions,
                })
    except Exception as e:
        warnings.append(f"Figure rendering failed: {type(e).__name__}: {e}")

    return figures


# ---------------------------------------------------------------------------
# Stage 1c: Reference parsing
# ---------------------------------------------------------------------------

def extract_references(markdown: str) -> list[dict]:
    """
    Extract references supporting both [N] numbered and author-year formats.
    Returns structured reference list.
    """
    refs = []

    ref_match = re.search(
        r'^#{1,3}\s*(?:References|Bibliography)\s*$',
        markdown,
        re.MULTILINE | re.IGNORECASE,
    )
    if not ref_match:
        ref_match = re.search(
            r'\n\s*(?:References|Bibliography)\s*\n',
            markdown,
            re.IGNORECASE,
        )
    if not ref_match:
        return refs

    ref_text = markdown[ref_match.end():]

    # Try numbered format first: [1], [2], ...
    numbered_items = re.split(r'\n\s*\[(\d+)\]\s*', ref_text)
    if len(numbered_items) > 2:
        for i in range(1, len(numbered_items) - 1, 2):
            num = numbered_items[i]
            text = numbered_items[i + 1].strip()
            if len(text) < 10:
                continue
            ref = parse_single_reference(text)
            ref["number"] = int(num)
            refs.append(ref)
        if refs:
            return refs[:100]

    # Try author-year format: split primarily on blank lines
    lines = ref_text.strip().split('\n')
    current_ref: list[str] = []
    for line in lines:
        line = line.strip()
        if not line:
            if current_ref:
                text = ' '.join(current_ref)
                if len(text) > 15:
                    refs.append(parse_single_reference(text))
                current_ref = []
            continue

        is_first_line = not current_ref
        starts_with_author = bool(re.match(r'^[A-Z][a-z]', line))
        prev_has_period = '.' in ' '.join(current_ref) if current_ref else False

        if is_first_line or (starts_with_author and prev_has_period):
            if current_ref:
                text = ' '.join(current_ref)
                if len(text) > 15:
                    refs.append(parse_single_reference(text))
            current_ref = [line]
        else:
            current_ref.append(line)

    if current_ref:
        text = ' '.join(current_ref)
        if len(text) > 15:
            refs.append(parse_single_reference(text))

    return refs[:100]


def parse_single_reference(text: str) -> dict:
    """Try to extract structured fields from a reference string."""
    ref: dict = {"text": text[:500]}

    year_match = re.search(r'\b((?:19|20)\d{2})\b', text)
    if year_match:
        ref["year"] = int(year_match.group(1))

    doi_match = re.search(r'(10\.\d{4,}/[^\s,]+)', text)
    if doi_match:
        ref["doi"] = doi_match.group(1).rstrip('.')

    arxiv_match = re.search(r'((?:arXiv:?)?\d{4}\.\d{4,5}(?:v\d+)?)', text)
    if arxiv_match:
        ref["arxiv_id"] = arxiv_match.group(1)

    return ref


# ---------------------------------------------------------------------------
# Metadata extraction
# ---------------------------------------------------------------------------

def extract_metadata(pdf_path: str, markdown: str) -> dict:
    """Extract title, authors, abstract. Prefer PDF metadata, fallback to heuristic."""
    meta = {"title": "Unknown", "authors": [], "abstract": "", "year": None}

    try:
        import fitz
        with fitz.open(pdf_path) as doc:
            pdf_meta = doc.metadata or {}

        if pdf_meta.get("title") and len(pdf_meta["title"].strip()) > 3:
            meta["title"] = pdf_meta["title"].strip()
        if pdf_meta.get("author"):
            meta["authors"] = [a.strip() for a in pdf_meta["author"].split(",") if a.strip()]
    except Exception:
        pass

    # If title is still generic, try heuristic from markdown
    if meta["title"] in ("Unknown", "", "untitled") or len(meta["title"]) < 4:
        lines = [l.strip() for l in markdown.split('\n') if l.strip()]
        for line in lines[:10]:
            clean = re.sub(r'^#+\s*', '', line).strip()
            if len(clean) > 10 and not clean.lower().startswith(('abstract', 'arxiv', 'http')):
                meta["title"] = clean[:300]
                break

    # Extract abstract
    abs_match = re.search(
        r'(?:^|\n)\s*(?:#+\s*)?(?:Abstract|ABSTRACT)\s*\n(.*?)(?=\n\s*(?:#{1,3}\s|\d+[\.\s]+Introduction|Keywords|1\s+Introduction))',
        markdown,
        re.DOTALL | re.IGNORECASE,
    )
    if abs_match:
        abstract = abs_match.group(1).strip()
        abstract = re.sub(r'\n+', ' ', abstract)
        abstract = re.sub(r'\s+', ' ', abstract)
        meta["abstract"] = abstract[:2000]

    # Extract year from metadata or text
    if not meta["year"]:
        year_match = re.search(r'\b((?:19|20)\d{2})\b', markdown[:2000])
        if year_match:
            meta["year"] = int(year_match.group(1))

    return meta


# ---------------------------------------------------------------------------
# Section-level chunking
# ---------------------------------------------------------------------------

def build_chunks(markdown: str, sections: list[dict], page_count: int) -> list[dict]:
    """
    Split markdown into section-level chunks with metadata.
    Each chunk corresponds to one heading and its content until the next heading.
    Includes a preamble chunk for content before the first heading.
    """
    if not sections:
        return [{
            "section_title": "Full Text",
            "level": 0,
            "page_start": 1,
            "page_end": max(page_count, 1),
            "content": markdown,
            "word_count": len(markdown.split()),
        }]

    chunks = []
    total_chars = max(len(markdown), 1)

    def estimate_page(char_pos: int) -> int:
        if page_count == 0:
            return 0
        ratio = char_pos / total_chars
        return max(1, min(page_count, int(ratio * page_count) + 1))

    # Preamble: content before first heading (title, abstract, etc.)
    if sections[0]["char_offset"] > 0:
        preamble = markdown[:sections[0]["char_offset"]].strip()
        if preamble and len(preamble) > 20:
            chunks.append({
                "section_title": "Preamble",
                "level": 0,
                "page_start": 1,
                "page_end": estimate_page(sections[0]["char_offset"]),
                "content": preamble,
                "word_count": len(preamble.split()),
            })

    for i, sec in enumerate(sections):
        start = sec["char_offset"]
        end = sections[i + 1]["char_offset"] if i + 1 < len(sections) else len(markdown)
        content = markdown[start:end].strip()

        page_start = estimate_page(start)
        page_end = estimate_page(end)
        # Ensure valid range
        page_end = max(page_start, page_end)

        chunks.append({
            "section_title": sec["title"],
            "level": sec["level"],
            "page_start": page_start,
            "page_end": page_end,
            "content": content,
            "word_count": len(content.split()),
        })

    return chunks


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def get_page_count(pdf_path: str) -> int:
    try:
        import fitz
        with fitz.open(pdf_path) as doc:
            return len(doc)
    except Exception:
        return 0


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: extract_pdf.py <pdf_path> <output_dir>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_dir = sys.argv[2]

    # Input validation
    pdf = Path(pdf_path)
    if not pdf.exists():
        print(json.dumps({"error": f"File not found: {pdf_path}"}))
        sys.exit(1)
    if not pdf.is_file():
        print(json.dumps({"error": f"Not a file: {pdf_path}"}))
        sys.exit(1)

    Path(output_dir).mkdir(parents=True, exist_ok=True)

    warnings: list[str] = []
    page_count = get_page_count(pdf_path)

    # Stage 1: Structured Markdown extraction
    markdown, sections = extract_markdown(pdf_path, warnings)

    # Stage 1b: Supplementary table extraction
    tables = extract_tables(pdf_path, warnings)

    # Stage 1c: Reference parsing
    references = extract_references(markdown)

    # Metadata
    metadata = extract_metadata(pdf_path, markdown)

    # Stage 2: Selective figure-page rendering (using actual page search)
    page_captions = detect_figure_pages(pdf_path, page_count)
    figures = render_figure_pages(pdf_path, output_dir, page_captions, warnings)

    # Build section chunks
    chunks = build_chunks(markdown, sections, page_count)

    # Determine status
    status = "ok"
    if not markdown.strip():
        status = "warning"
        warnings.append("No text extracted - PDF may be image-only, corrupt, or empty")

    result = {
        "text": {
            "markdown": markdown,
            "full_text": markdown,  # backward compat alias
            "sections": sections,
            "tables": tables,
        },
        "figures": figures,
        "references": references,
        "metadata": metadata,
        "chunks": chunks,
        "page_count": page_count,
    }

    output_file = Path(output_dir) / "extraction.json"
    output_file.write_text(json.dumps(result, ensure_ascii=False, indent=2))

    # Write markdown separately for PaperQA2 indexing
    md_file = Path(output_dir) / "content.md"
    md_file.write_text(markdown, encoding="utf-8")

    print(json.dumps({
        "status": status,
        "output": str(output_file),
        "markdown_file": str(md_file),
        "figures": len(figures),
        "figure_pages": list(page_captions.keys()),
        "sections": len(sections),
        "chunks": len(chunks),
        "references": len(references),
        "text_length": len(markdown),
        "page_count": page_count,
        "warnings": warnings if warnings else None,
    }))


if __name__ == "__main__":
    main()
