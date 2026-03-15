---
name: paper-template
description: "Initialize paper LaTeX template"
allowed-tools: Read Write Bash
---

# Paper Template Skill

When you need to initialize a paper template, use this skill.

## Supported Templates

- **neurips**: NeurIPS conference template
- **icml**: ICML conference template
- **aaai**: AAAI conference template
- **acl**: ACL conference template
- **jfe**: Journal of Financial Economics
- **rfs**: Review of Financial Studies
- **custom**: User-defined generic article template

## Operations

1. **Copy template files** from `templates/{template_name}/` to `paper/`
2. **Set up `main.tex`** with the `\input` structure for all standard sections
3. **Create `sections/` directory** with blank section files:
   - `sections/abstract.tex`
   - `sections/introduction.tex`
   - `sections/related-work.tex`
   - `sections/methodology.tex`
   - `sections/experiments.tex`
   - `sections/results.tex`
   - `sections/conclusion.tex`
4. **Create supporting directories**:
   - `paper/figures/`
   - `paper/tables/`
5. **Copy or create `Makefile`** for compilation
6. **Create empty `references.bib`** if not already present
7. **Verify the template compiles** by running a test compilation

## Section File Format

Each blank section file should contain a commented placeholder:

```latex
% TODO: Write content for this section
```

## Post-Initialization Checklist

- [ ] `paper/main.tex` exists and has correct `\input` references
- [ ] All section files exist in `paper/sections/`
- [ ] `paper/references.bib` exists
- [ ] `paper/Makefile` exists
- [ ] Template compiles without errors (empty sections are acceptable)
