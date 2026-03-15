---
name: literature-search
description: "Execute multi-database academic literature search"
allowed-tools: ArxivSearch SemanticScholarSearch SSRNSearch PaperDownload Read Write Bash
---

# Literature Search Skill

When the user requests an academic literature search, use this skill.

## Steps

1. **Parse query and generate search keywords**
   - Analyze the user's research topic and extract core keywords and related concepts
   - Generate multiple sets of search queries (in English) covering:
     - Direct search on the core topic
     - Related methodology search
     - Cross-domain intersection search
   - Tailor queries per database (arXiv category codes, Semantic Scholar field filters, etc.)

2. **Parallel multi-database search**
   - Search arXiv (focus on relevant categories such as q-fin, stat.ML, cs.LG)
   - Search Semantic Scholar (leverage citation graphs to discover key papers)
   - Search SSRN (financial economics and related domains)
   - For highly cited papers, traverse citation networks (forward + backward citations)

3. **Merge and deduplicate results**
   - Deduplicate based on DOI or title similarity
   - Consolidate metadata from multiple sources into a unified record

4. **Rank by citation count and relevance**
   - Sort results by a weighted combination of citation count and relevance score
   - Filter to top-50 core papers

5. **Return structured result list**
   - Each result includes: title, authors, year, venue, abstract, citation count, source database, PDF URL
   - Flag open-access availability
   - Indicate papers that may require manual download (e.g., gated SSRN papers)

## Notes

- Prioritize papers from the last 3 years, but do not ignore foundational work
- Tag each paper with its source database
- If a search direction yields insufficient results, explicitly note "insufficient literature" rather than fabricating entries
- Respect API rate limits: arXiv (~1 request per 3 seconds), Semantic Scholar (configure S2_API_KEY for higher limits)
