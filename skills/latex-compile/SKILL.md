---
name: latex-compile
description: "Compile LaTeX paper and auto-fix errors"
allowed-tools: Read Write Bash Grep
---

# LaTeX Compile Skill

When you need to compile a LaTeX file, use this skill.

## Compilation Loop

1. Run `latexmk -pdf -pdflatex="pdflatex -interaction=nonstopmode" main.tex`
2. Check the exit code; if successful, finish
3. Parse `main.log` to locate errors
4. Classify each error and apply automatic fixes
5. Re-compile (retry up to 10 times)
6. If compilation still fails after max retries, compile all unresolved errors into a report for the user

## Common Fix Mappings

| Error Pattern | Fix Strategy |
|---|---|
| `Undefined control sequence` | Add the corresponding `\usepackage{}` or define the missing macro |
| `Missing $ inserted` | Check and correct math environment boundaries |
| `File not found` | Verify the file path; try common path variants |
| `Citation undefined` | Run bibtex/biber or check the `.bib` file for the missing key |
| `Label multiply defined` | Rename duplicate labels to be unique |
| `Missing \begin{document}` | Ensure document preamble is well-formed |
| `Too many }'s` | Trace and fix unbalanced braces |
| `Environment undefined` | Add the package that provides the environment |

## Compilation Command Details

- Default compiler: `pdflatex` (configurable to `xelatex` or `lualatex`)
- Use `latexmk` to handle multi-pass compilation automatically (resolves cross-references, bibliography)
- Parse the `.log` file to extract structured error information including file, line number, error type, and surrounding context

## Output

- On success: path to the compiled PDF (e.g., `paper/main.pdf`)
- On failure: structured error report with all unresolved errors and attempted fixes
- Always produce `paper/compile-log.md` documenting the compilation process
